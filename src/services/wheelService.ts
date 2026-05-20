import prisma from "../config/database.js";
import { getConfigNumber } from "../config/appConfig.js";
import { CoinService } from "./coinService.js";

/**
 * WheelService handles all spin wheel lifecycle operations.
 */
export class WheelService {
  /**
   * Create a new spin wheel. Only one active wheel allowed at a time.
   */
  static async createWheel(adminId: string, entryFee?: number): Promise<any> {
    // Check for existing active wheel
    const activeWheel = await prisma.spinWheel.findFirst({
      where: {
        status: { in: ["waiting", "active", "spinning"] },
      },
    });

    if (activeWheel) {
      throw new Error(
        `An active spin wheel already exists (ID: ${activeWheel.id}, Status: ${activeWheel.status}). ` +
        `Only one active wheel is allowed at a time.`
      );
    }

    const fee = entryFee ?? getConfigNumber("default_entry_fee");
    const minParticipants = getConfigNumber("min_participants");

    const wheel = await prisma.spinWheel.create({
      data: {
        entryFee: fee,
        minParticipants,
        adminId,
        status: "waiting",
      },
      include: {
        admin: { select: { id: true, username: true } },
        participants: { include: { user: { select: { id: true, username: true } } } },
      },
    });

    console.log(`🎡 Spin wheel created by admin ${adminId} | Entry fee: ${fee} | ID: ${wheel.id}`);
    return wheel;
  }

  /**
   * Join a spin wheel by paying the entry fee.
   */
  static async joinWheel(userId: string, wheelId: string): Promise<any> {
    const wheel = await prisma.spinWheel.findUniqueOrThrow({
      where: { id: wheelId },
      include: { participants: true },
    });

    // Validations
    if (wheel.status !== "waiting") {
      throw new Error(`Cannot join wheel. Current status: ${wheel.status}. Must be 'waiting'.`);
    }

    if (wheel.adminId === userId) {
      throw new Error("Admin cannot join their own spin wheel as a participant.");
    }

    const alreadyJoined = wheel.participants.some((p) => p.userId === userId);
    if (alreadyJoined) {
      throw new Error("You have already joined this spin wheel.");
    }

    // Check user balance
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { coins: true, username: true },
    });

    if (user.coins < wheel.entryFee) {
      throw new Error(
        `Insufficient coins. Required: ${wheel.entryFee}, Available: ${user.coins}`
      );
    }

    // Process entry fee (atomic transaction)
    const distribution = await CoinService.processEntryFee(
      userId,
      wheelId,
      wheel.entryFee,
      wheel.adminId
    );

    // Add participant
    const participant = await prisma.participant.create({
      data: {
        userId,
        spinWheelId: wheelId,
        status: "active",
      },
      include: {
        user: { select: { id: true, username: true, coins: true } },
      },
    });

    console.log(`👤 User ${user.username} joined wheel ${wheelId} | Fee: ${wheel.entryFee}`);

    return {
      participant,
      distribution,
      totalParticipants: wheel.participants.length + 1,
    };
  }

  /**
   * Start a spin wheel (manual trigger by admin).
   */
  static async startWheel(wheelId: string, adminId: string): Promise<any> {
    const wheel = await prisma.spinWheel.findUniqueOrThrow({
      where: { id: wheelId },
      include: {
        participants: {
          where: { status: "active" },
          include: { user: { select: { id: true, username: true } } },
        },
      },
    });

    if (wheel.adminId !== adminId) {
      throw new Error("Only the wheel creator can start the wheel.");
    }

    if (wheel.status !== "waiting") {
      throw new Error(`Cannot start wheel. Current status: ${wheel.status}`);
    }

    const minParticipants = wheel.minParticipants;
    if (wheel.participants.length < minParticipants) {
      throw new Error(
        `Minimum ${minParticipants} participants required. Current: ${wheel.participants.length}`
      );
    }

    // Generate random elimination order
    const participantIds = wheel.participants.map((p) => p.userId);
    const eliminationOrder = WheelService.shuffleArray([...participantIds]);

    const updatedWheel = await prisma.spinWheel.update({
      where: { id: wheelId },
      data: {
        status: "spinning",
        startedAt: new Date(),
        eliminationOrder: JSON.stringify(eliminationOrder),
      },
      include: {
        participants: {
          include: { user: { select: { id: true, username: true } } },
        },
        admin: { select: { id: true, username: true } },
      },
    });

    console.log(`🎰 Wheel ${wheelId} started! Elimination order generated.`);

    return {
      wheel: updatedWheel,
      eliminationOrder,
      totalParticipants: wheel.participants.length,
    };
  }

  /**
   * Auto-start check: called by the timer after 3 minutes.
   * If minimum participants met → start. Otherwise → abort and refund.
   */
  static async autoStartOrAbort(wheelId: string): Promise<{
    action: "started" | "aborted";
    wheel: any;
    refundCount?: number;
  }> {
    const wheel = await prisma.spinWheel.findUnique({
      where: { id: wheelId },
      include: {
        participants: {
          where: { status: "active" },
          include: { user: { select: { id: true, username: true } } },
        },
        admin: { select: { id: true, username: true } },
      },
    });

    if (!wheel || wheel.status !== "waiting") {
      throw new Error("Wheel not found or not in waiting status.");
    }

    const minParticipants = wheel.minParticipants;

    if (wheel.participants.length >= minParticipants) {
      // Enough participants → start the wheel
      const participantIds = wheel.participants.map((p) => p.userId);
      const eliminationOrder = WheelService.shuffleArray([...participantIds]);

      const updatedWheel = await prisma.spinWheel.update({
        where: { id: wheelId },
        data: {
          status: "spinning",
          startedAt: new Date(),
          eliminationOrder: JSON.stringify(eliminationOrder),
        },
        include: {
          participants: {
            include: { user: { select: { id: true, username: true } } },
          },
          admin: { select: { id: true, username: true } },
        },
      });

      console.log(`⏱️ Auto-start: Wheel ${wheelId} started with ${wheel.participants.length} participants`);
      return { action: "started", wheel: updatedWheel };
    } else {
      // Not enough participants → abort and refund
      const refundCount = await CoinService.processRefunds(wheelId);

      const updatedWheel = await prisma.spinWheel.findUniqueOrThrow({
        where: { id: wheelId },
        include: {
          participants: {
            include: { user: { select: { id: true, username: true } } },
          },
          admin: { select: { id: true, username: true } },
        },
      });

      console.log(
        `❌ Auto-abort: Wheel ${wheelId} aborted. Only ${wheel.participants.length}/${minParticipants} participants. Refunded ${refundCount} users.`
      );
      return { action: "aborted", wheel: updatedWheel, refundCount };
    }
  }

  /**
   * Eliminate a participant from the wheel.
   * Returns the eliminated user and whether the game is complete.
   */
  static async eliminateNext(wheelId: string): Promise<{
    eliminated: { userId: string; username: string } | null;
    winner: { userId: string; username: string } | null;
    remainingCount: number;
    isComplete: boolean;
  }> {
    const wheel = await prisma.spinWheel.findUniqueOrThrow({
      where: { id: wheelId },
      include: {
        participants: {
          where: { status: "active" },
          include: { user: { select: { id: true, username: true } } },
        },
      },
    });

    if (wheel.status !== "spinning") {
      throw new Error(`Wheel is not spinning. Status: ${wheel.status}`);
    }

    if (!wheel.eliminationOrder) {
      throw new Error("No elimination order found.");
    }

    const eliminationOrder: string[] = JSON.parse(wheel.eliminationOrder);
    const activeParticipants = wheel.participants;

    if (activeParticipants.length <= 1) {
      // Game already over or only one left
      const winner = activeParticipants[0];
      if (winner) {
        return {
          eliminated: null,
          winner: { userId: winner.userId, username: winner.user.username },
          remainingCount: 1,
          isComplete: true,
        };
      }
      throw new Error("No active participants found.");
    }

    // Find the next user to eliminate (first in elimination order that's still active)
    const activeIds = new Set(activeParticipants.map((p) => p.userId));
    const nextToEliminate = eliminationOrder.find((id) => activeIds.has(id));

    if (!nextToEliminate) {
      throw new Error("Elimination order inconsistency.");
    }

    // Eliminate the participant
    const eliminatedParticipant = activeParticipants.find(
      (p) => p.userId === nextToEliminate
    )!;

    await prisma.participant.update({
      where: { id: eliminatedParticipant.id },
      data: {
        status: "eliminated",
        eliminatedAt: new Date(),
      },
    });

    // Remove from elimination order
    const updatedOrder = eliminationOrder.filter((id) => id !== nextToEliminate);
    await prisma.spinWheel.update({
      where: { id: wheelId },
      data: { eliminationOrder: JSON.stringify(updatedOrder) },
    });

    const remainingCount = activeParticipants.length - 1;

    console.log(
      `💀 Eliminated ${eliminatedParticipant.user.username} from wheel ${wheelId}. Remaining: ${remainingCount}`
    );

    // Check if we have a winner (only 1 remaining)
    if (remainingCount === 1) {
      const winner = activeParticipants.find((p) => p.userId !== nextToEliminate)!;

      // Mark winner
      await prisma.participant.update({
        where: { id: winner.id },
        data: { status: "winner" },
      });

      // Mark wheel as completed
      await prisma.spinWheel.update({
        where: { id: wheelId },
        data: {
          status: "completed",
          winnerId: winner.userId,
          completedAt: new Date(),
        },
      });

      // Process final payout
      const payout = await CoinService.processFinalPayout(wheelId);

      console.log(
        `🏆 Winner: ${winner.user.username} | Payout: ${payout.winnerPayout} coins`
      );

      return {
        eliminated: {
          userId: nextToEliminate,
          username: eliminatedParticipant.user.username,
        },
        winner: { userId: winner.userId, username: winner.user.username },
        remainingCount: 1,
        isComplete: true,
      };
    }

    return {
      eliminated: {
        userId: nextToEliminate,
        username: eliminatedParticipant.user.username,
      },
      winner: null,
      remainingCount,
      isComplete: false,
    };
  }

  /**
   * Get the current active wheel with all details.
   */
  static async getActiveWheel(): Promise<any | null> {
    return prisma.spinWheel.findFirst({
      where: {
        status: { in: ["waiting", "active", "spinning"] },
      },
      include: {
        participants: {
          include: { user: { select: { id: true, username: true } } },
        },
        admin: { select: { id: true, username: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Get wheel by ID with full details.
   */
  static async getWheelById(wheelId: string): Promise<any> {
    return prisma.spinWheel.findUniqueOrThrow({
      where: { id: wheelId },
      include: {
        participants: {
          include: { user: { select: { id: true, username: true } } },
          orderBy: { joinedAt: "asc" },
        },
        admin: { select: { id: true, username: true } },
        transactions: {
          orderBy: { createdAt: "desc" },
        },
      },
    });
  }

  /**
   * Get wheel history (completed/aborted wheels).
   */
  static async getWheelHistory(limit: number = 20): Promise<any[]> {
    return prisma.spinWheel.findMany({
      where: {
        status: { in: ["completed", "aborted"] },
      },
      include: {
        participants: {
          include: { user: { select: { id: true, username: true } } },
        },
        admin: { select: { id: true, username: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  /**
   * Fisher-Yates shuffle for fair random elimination order.
   */
  private static shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j]!, array[i]!];
    }
    return array;
  }
}
