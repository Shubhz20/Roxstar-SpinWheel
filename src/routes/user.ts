import { Router } from "express";
import { authenticate, type AuthRequest } from "../middleware/auth.js";
import prisma from "../config/database.js";
import { CoinService } from "../services/coinService.js";

const router = Router();

/**
 * GET /api/user/profile
 * Get current user's profile.
 */
router.get("/profile", authenticate, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.user!.id },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        coins: true,
        createdAt: true,
      },
    });
    res.json({ user });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/user/balance
 * Get current user's coin balance.
 */
router.get("/balance", authenticate, async (req: AuthRequest, res) => {
  try {
    const coins = await CoinService.getBalance(req.user!.id);
    res.json({ coins });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/user/transactions
 * Get current user's transaction history.
 */
router.get("/transactions", authenticate, async (req: AuthRequest, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const transactions = await prisma.transaction.findMany({
      where: { userId: req.user!.id },
      include: {
        spinWheel: {
          select: { id: true, status: true, entryFee: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    res.json({ transactions });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/user/add-coins
 * Add coins to a user (admin only, for testing/gifting).
 */
router.post("/add-coins", authenticate, async (req: AuthRequest, res) => {
  try {
    if (req.user!.role !== "admin") {
      res.status(403).json({ error: "Admin access required." });
      return;
    }

    const { userId, amount } = req.body;
    if (!userId || !amount || amount <= 0) {
      res.status(400).json({ error: "Valid userId and positive amount required." });
      return;
    }

    const newBalance = await CoinService.addCoins(userId, amount, "Admin coin grant");
    res.json({ message: "Coins added successfully.", userId, newBalance });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/user/all
 * Get all users (admin only).
 */
router.get("/all", authenticate, async (req: AuthRequest, res) => {
  try {
    if (req.user!.role !== "admin") {
      res.status(403).json({ error: "Admin access required." });
      return;
    }

    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        coins: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ users });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
