import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import prisma from "../config/database.js";

const JWT_SECRET = process.env.JWT_SECRET || "roxstar-spin-wheel-secret-key";

// Extend Express Request to include user info
export interface AuthRequest extends Request {
  user?: {
    id: string;
    username: string;
    role: string;
  };
}

/**
 * JWT Authentication middleware.
 * Extracts token from Authorization header (Bearer <token>).
 */
export async function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required. Provide Bearer token." });
      return;
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      res.status(401).json({ error: "Invalid token format." });
      return;
    }

    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId: string;
      username: string;
      role: string;
    };

    // Verify user still exists
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, username: true, role: true },
    });

    if (!user) {
      res.status(401).json({ error: "User no longer exists." });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: "Invalid or expired token." });
      return;
    }
    res.status(500).json({ error: "Authentication error." });
  }
}

/**
 * Admin-only middleware. Must be used AFTER authenticate.
 */
export function requireAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user || req.user.role !== "admin") {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  next();
}

/**
 * Generate a JWT token for a user.
 */
export function generateToken(user: { id: string; username: string; role: string }): string {
  return jwt.sign(
    { userId: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: "24h" }
  );
}
