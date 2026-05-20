import prisma from "../config/database.js";
import { getCoinDistribution } from "../config/appConfig.js";

/**
 * CoinService handles all coin-related operations with atomic transactions.
 * Ensures no partial credits/debits and handles concurrent updates safely.
 */
export class CoinService {
  /**
   * Process entry fee when a user joins a spin wheel.
   * Deducts coins from user and distributes to winner/admin/app pools.
   * All operations are atomic via Prisma transaction.
   */
  static async processEntryFee(
    userId: string,
    spinWheelId: string,
    entryFee: number,
    adminId: string
  ): Promise<{ winnerShare: number; adminShare: number; appShare: number }> {
    const { winnerPercent, adminPercent, appPercent } = getCoinDistribution();

    const winnerShare = (entryFee * winnerPercent) / 100;
    const adminShare = (entryFee * adminPercent) / 100;
    const appShare = (entryFee * appPercent) / 100;

    // Atomic transaction: deduct from user, distribute to pools, record transactions
    await prisma.$transaction(async (tx) => {
      // 1. Verify user has enough coins (with pessimistic check)
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { coins: true, username: true },
      });

      if (user.coins < entryFee) {
        throw new Error(
          `Insufficient coins. Required: ${entryFee}, Available: ${user.coins}`
        );
      }

      // 2. Deduct entry fee from user
      await tx.user.update({
        where: { id: userId },
        data: { coins: { decrement: entryFee } },
      });

      // 3. Update spin wheel pool accumulators
      await tx.spinWheel.update({
        where: { id: spinWheelId },
        data: {
          winnerPool: { increment: winnerShare },
          adminPool: { increment: adminShare },
          appPool: { increment: appShare },
        },
      });

      // 4. Record the entry fee transaction
      await tx.transaction.create({
        data: {
          type: "entry_fee",
          amount: -entryFee,
          userId: userId,
          spinWheelId: spinWheelId,
          description: `Entry fee for spin wheel`,
        },
      });
    });

    return { winnerShare, adminShare, appShare };
  }

  /**
   * Process final payout when the spin wheel completes.
   * Credits the winner and admin with their accumulated pools.
   * All operations are atomic.
   */
  static async processFinalPayout(spinWheelId: string): Promise<{
    winnerId: string;
    winnerPayout: number;
    adminPayout: number;
    appPayout: number;
  }> {
    return await prisma.$transaction(async (tx) => {
      // 1. Get the spin wheel with accumulated pools
      const wheel = await tx.spinWheel.findUniqueOrThrow({
        where: { id: spinWheelId },
        include: {
          participants: {
            where: { status: "winner" },
            include: { user: true },
          },
        },
      });

      if (!wheel.winnerId) {
        throw new Error("No winner determined for this spin wheel.");
      }

      const winnerPayout = wheel.winnerPool;
      const adminPayout = wheel.adminPool;
      const appPayout = wheel.appPool;

      // 2. Credit winner with winner pool
      await tx.user.update({
        where: { id: wheel.winnerId },
        data: { coins: { increment: winnerPayout } },
      });

      // 3. Credit admin with admin pool
      await tx.user.update({
        where: { id: wheel.adminId },
        data: { coins: { increment: adminPayout } },
      });

      // 4. Record winner payout transaction
      await tx.transaction.create({
        data: {
          type: "winner_payout",
          amount: winnerPayout,
          userId: wheel.winnerId,
          spinWheelId,
          description: `Winner payout from spin wheel`,
        },
      });

      // 5. Record admin payout transaction
      await tx.transaction.create({
        data: {
          type: "admin_payout",
          amount: adminPayout,
          userId: wheel.adminId,
          spinWheelId,
          description: `Admin payout from spin wheel`,
        },
      });

      // 6. Record app fee transaction (system/platform revenue)
      await tx.transaction.create({
        data: {
          type: "app_fee",
          amount: appPayout,
          userId: wheel.adminId, // Track under admin for auditing
          spinWheelId,
          description: `Platform fee from spin wheel`,
        },
      });

      return {
        winnerId: wheel.winnerId,
        winnerPayout,
        adminPayout,
        appPayout,
      };
    });
  }

  /**
   * Refund all participants when a wheel is aborted.
   * Returns coins to each participant atomically.
   */
  static async processRefunds(spinWheelId: string): Promise<number> {
    return await prisma.$transaction(async (tx) => {
      const wheel = await tx.spinWheel.findUniqueOrThrow({
        where: { id: spinWheelId },
        include: { participants: true },
      });

      let refundCount = 0;

      for (const participant of wheel.participants) {
        // Credit the entry fee back to the user
        await tx.user.update({
          where: { id: participant.userId },
          data: { coins: { increment: wheel.entryFee } },
        });

        // Record refund transaction
        await tx.transaction.create({
          data: {
            type: "refund",
            amount: wheel.entryFee,
            userId: participant.userId,
            spinWheelId,
            description: `Refund: spin wheel aborted (insufficient participants)`,
          },
        });

        refundCount++;
      }

      // Reset wheel pools
      await tx.spinWheel.update({
        where: { id: spinWheelId },
        data: {
          winnerPool: 0,
          adminPool: 0,
          appPool: 0,
          status: "aborted",
        },
      });

      return refundCount;
    });
  }

  /**
   * Get a user's coin balance.
   */
  static async getBalance(userId: string): Promise<number> {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { coins: true },
    });
    return user.coins;
  }

  /**
   * Add coins to a user's balance (e.g., for initial deposit by admin).
   */
  static async addCoins(userId: string, amount: number, description?: string): Promise<number> {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { coins: { increment: amount } },
    });
    return user.coins;
  }
}
