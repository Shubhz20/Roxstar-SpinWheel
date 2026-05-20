import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server as SocketServer } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import prisma from "./config/database.js";
import { loadConfig } from "./config/appConfig.js";
import { initializeSocket } from "./socket/wheelSocket.js";

// Routes
import authRoutes from "./routes/auth.js";
import wheelRoutes from "./routes/wheel.js";
import userRoutes from "./routes/user.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);

// ─── Socket.IO Setup ─────────────────────────────────────────────────────────
const io = new SocketServer(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, "../public")));

// ─── Request Logging ──────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} | ${req.method} ${req.url}`);
  next();
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/wheel", wheelRoutes);
app.use("/api/user", userRoutes);

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ─── Serve frontend for all non-API routes ────────────────────────────────────
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);

async function startServer(): Promise<void> {
  try {
    // Test database connection
    await prisma.$connect();
    console.log("✅ Database connected");

    // Load app configuration from database
    await loadConfig();

    // Initialize Socket.IO handlers
    initializeSocket(io);

    httpServer.listen(PORT, () => {
      console.log(`
╔══════════════════════════════════════════════════╗
║        🎡 ROXSTAR SPIN WHEEL GAME SERVER         ║
╠══════════════════════════════════════════════════╣
║  Server:    http://localhost:${PORT}                ║
║  API:       http://localhost:${PORT}/api             ║
║  WebSocket: ws://localhost:${PORT}                  ║
║  Health:    http://localhost:${PORT}/api/health       ║
╚══════════════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down gracefully...");
  await prisma.$disconnect();
  io.close();
  httpServer.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 Shutting down gracefully...");
  await prisma.$disconnect();
  io.close();
  httpServer.close();
  process.exit(0);
});

startServer();
