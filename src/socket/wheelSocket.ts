import type { Server as SocketServer, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { WheelService } from "../services/wheelService.js";
import { getConfigNumber } from "../config/appConfig.js";

const JWT_SECRET = process.env.JWT_SECRET || "roxstar-spin-wheel-secret-key";

// Track active timers so we can clean them up
const activeTimers: Map<string, NodeJS.Timeout[]> = new Map();

/**
 * Clear all timers for a specific wheel.
 */
function clearWheelTimers(wheelId: string): void {
  const timers = activeTimers.get(wheelId);
  if (timers) {
    timers.forEach((t) => clearTimeout(t));
    activeTimers.delete(wheelId);
    console.log(`🧹 Cleared all timers for wheel ${wheelId}`);
  }
}

/**
 * Add a timer for a specific wheel.
 */
function addWheelTimer(wheelId: string, timer: NodeJS.Timeout): void {
  if (!activeTimers.has(wheelId)) {
    activeTimers.set(wheelId, []);
  }
  activeTimers.get(wheelId)!.push(timer);
}

/**
 * Initialize Socket.IO event handlers for real-time spin wheel communication.
 */
export function initializeSocket(io: SocketServer): void {
  // ─── Authentication middleware for socket connections ───────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    if (!token) {
      // Allow unauthenticated connections as spectators
      (socket as any).user = { id: "spectator", username: "Spectator", role: "spectator" };
      return next();
    }

    try {
      const decoded = jwt.verify(token as string, JWT_SECRET) as {
        userId: string;
        username: string;
        role: string;
      };
      (socket as any).user = {
        id: decoded.userId,
        username: decoded.username,
        role: decoded.role,
      };
      next();
    } catch (err) {
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const user = (socket as any).user;
    console.log(`🔌 Socket connected: ${user.username} (${user.id})`);

    // Join the general room
    socket.join("spin-wheel-lobby");

    // Send current wheel state on connect
    sendCurrentState(socket);

    // ─── Admin: Create Wheel ─────────────────────────────────────────────
    socket.on("wheel:create", async (data, callback) => {
      try {
        if (user.role !== "admin") {
          callback?.({ error: "Admin access required." });
          return;
        }

        const wheel = await WheelService.createWheel(user.id, data?.entryFee);

        // Join the wheel-specific room
        socket.join(`wheel:${wheel.id}`);

        // Notify all clients
        io.to("spin-wheel-lobby").emit("wheel:created", {
          wheel,
          message: `New spin wheel created by ${user.username}! Entry fee: ${wheel.entryFee} coins`,
        });

        // Start the auto-start timer (3 minutes)
        const autoStartDelay = getConfigNumber("auto_start_delay_ms");
        console.log(`⏱️ Auto-start timer set for ${autoStartDelay / 1000}s for wheel ${wheel.id}`);

        const autoStartTimer = setTimeout(async () => {
          try {
            const result = await WheelService.autoStartOrAbort(wheel.id);

            if (result.action === "started") {
              io.to("spin-wheel-lobby").emit("wheel:started", {
                wheel: result.wheel,
                message: "Wheel auto-started! Eliminations beginning...",
                autoStarted: true,
              });
              // Begin elimination process
              startEliminationProcess(io, wheel.id);
            } else {
              io.to("spin-wheel-lobby").emit("wheel:aborted", {
                wheel: result.wheel,
                refundCount: result.refundCount,
                message: `Wheel aborted: insufficient participants. ${result.refundCount} users refunded.`,
              });
              clearWheelTimers(wheel.id);
            }
          } catch (err: any) {
            console.error("Auto-start error:", err);
          }
        }, autoStartDelay);

        addWheelTimer(wheel.id, autoStartTimer);
        callback?.({ success: true, wheel });
      } catch (error: any) {
        console.error("wheel:create error:", error);
        callback?.({ error: error.message });
      }
    });

    // ─── User: Join Wheel ────────────────────────────────────────────────
    socket.on("wheel:join", async (data, callback) => {
      try {
        if (user.role === "spectator") {
          callback?.({ error: "Authentication required to join." });
          return;
        }

        const result = await WheelService.joinWheel(user.id, data.wheelId);

        // Join the wheel-specific room
        socket.join(`wheel:${data.wheelId}`);

        // Notify all clients
        io.to("spin-wheel-lobby").emit("wheel:user-joined", {
          wheelId: data.wheelId,
          user: { id: user.id, username: user.username },
          totalParticipants: result.totalParticipants,
          distribution: result.distribution,
          message: `${user.username} joined the wheel!`,
        });

        callback?.({ success: true, ...result });
      } catch (error: any) {
        console.error("wheel:join error:", error);
        callback?.({ error: error.message });
      }
    });

    // ─── Admin: Manual Start ─────────────────────────────────────────────
    socket.on("wheel:start", async (data, callback) => {
      try {
        if (user.role !== "admin") {
          callback?.({ error: "Admin access required." });
          return;
        }

        const result = await WheelService.startWheel(data.wheelId, user.id);

        // Cancel auto-start timer since we're starting manually
        clearWheelTimers(data.wheelId);

        io.to("spin-wheel-lobby").emit("wheel:started", {
          wheel: result.wheel,
          totalParticipants: result.totalParticipants,
          message: "Wheel started by admin! Eliminations beginning...",
          autoStarted: false,
        });

        // Begin elimination process
        startEliminationProcess(io, data.wheelId);

        callback?.({ success: true, ...result });
      } catch (error: any) {
        console.error("wheel:start error:", error);
        callback?.({ error: error.message });
      }
    });

    // ─── Disconnect ──────────────────────────────────────────────────────
    socket.on("disconnect", () => {
      console.log(`🔌 Socket disconnected: ${user.username}`);
    });
  });

  console.log("✅ Socket.IO handlers initialized");
}

/**
 * Send current wheel state to a newly connected socket.
 */
async function sendCurrentState(socket: Socket): Promise<void> {
  try {
    const wheel = await WheelService.getActiveWheel();
    socket.emit("wheel:current-state", {
      wheel,
      message: wheel ? `Active wheel: ${wheel.status}` : "No active wheel",
    });
  } catch (error) {
    console.error("Error sending current state:", error);
  }
}

/**
 * Start the elimination process for a spinning wheel.
 * Eliminates one user every 7 seconds until a winner is determined.
 */
function startEliminationProcess(io: SocketServer, wheelId: string): void {
  const eliminationInterval = getConfigNumber("elimination_interval_ms");

  console.log(`💀 Starting elimination process for wheel ${wheelId} (every ${eliminationInterval / 1000}s)`);

  const processNextElimination = async () => {
    try {
      const result = await WheelService.eliminateNext(wheelId);

      if (result.eliminated) {
        io.to("spin-wheel-lobby").emit("wheel:elimination", {
          wheelId,
          eliminated: result.eliminated,
          remainingCount: result.remainingCount,
          message: `${result.eliminated.username} has been eliminated!`,
        });
      }

      if (result.isComplete && result.winner) {
        // Game over! Announce winner
        io.to("spin-wheel-lobby").emit("wheel:completed", {
          wheelId,
          winner: result.winner,
          message: `🏆 ${result.winner.username} wins the spin wheel!`,
        });

        clearWheelTimers(wheelId);
        console.log(`🏆 Wheel ${wheelId} completed. Winner: ${result.winner.username}`);
      } else if (!result.isComplete) {
        // Schedule next elimination
        const timer = setTimeout(processNextElimination, eliminationInterval);
        addWheelTimer(wheelId, timer);
      }
    } catch (error: any) {
      console.error(`Elimination error for wheel ${wheelId}:`, error);
      clearWheelTimers(wheelId);

      io.to("spin-wheel-lobby").emit("wheel:error", {
        wheelId,
        message: `Elimination error: ${error.message}`,
      });
    }
  };

  // Start first elimination after the interval
  const timer = setTimeout(processNextElimination, eliminationInterval);
  addWheelTimer(wheelId, timer);
}
