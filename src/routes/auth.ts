import { Router } from "express";
import bcrypt from "bcryptjs";
import prisma from "../config/database.js";
import { generateToken } from "../middleware/auth.js";

const router = Router();

/**
 * POST /api/auth/register
 * Register a new user.
 */
router.post("/register", async (req, res) => {
  try {
    const { username, email, password, role } = req.body;

    if (!username || !email || !password) {
      res.status(400).json({ error: "Username, email, and password are required." });
      return;
    }

    // Check if username or email already exists
    const existing = await prisma.user.findFirst({
      where: {
        OR: [{ username }, { email }],
      },
    });

    if (existing) {
      res.status(409).json({
        error: existing.username === username
          ? "Username already taken."
          : "Email already registered.",
      });
      return;
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user with initial coins
    const user = await prisma.user.create({
      data: {
        username,
        email,
        password: hashedPassword,
        role: role === "admin" ? "admin" : "user",
        coins: 1000, // Starting coins for new users
      },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        coins: true,
        createdAt: true,
      },
    });

    const token = generateToken(user);

    res.status(201).json({
      message: "User registered successfully.",
      user,
      token,
    });
  } catch (error: any) {
    console.error("Registration error:", error);
    res.status(500).json({ error: "Failed to register user.", details: error.message });
  }
});

/**
 * POST /api/auth/login
 * Login with username/email and password.
 */
router.post("/login", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if ((!username && !email) || !password) {
      res.status(400).json({ error: "Username/email and password are required." });
      return;
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          ...(username ? [{ username }] : []),
          ...(email ? [{ email }] : []),
        ],
      },
    });

    if (!user) {
      res.status(401).json({ error: "Invalid credentials." });
      return;
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      res.status(401).json({ error: "Invalid credentials." });
      return;
    }

    const token = generateToken(user);

    res.json({
      message: "Login successful.",
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        coins: user.coins,
      },
      token,
    });
  } catch (error: any) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Failed to login.", details: error.message });
  }
});

export default router;
