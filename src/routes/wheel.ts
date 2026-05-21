import { Router } from "express";
import { authenticate, requireAdmin, type AuthRequest } from "../middleware/auth.js";
import { WheelService } from "../services/wheelService.js";
import { getConfig, setConfig, loadConfig, getCoinDistribution } from "../config/appConfig.js";

const router = Router();

/**
 * POST /api/wheel/create
 * Create a new spin wheel. Admin only.
 */
router.post("/create", authenticate, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { entryFee } = req.body;
    const wheel = await WheelService.createWheel(req.user!.id, entryFee);

    res.status(201).json({
      message: "Spin wheel created successfully.",
      wheel,
    });
  } catch (error: any) {
    console.error("Create wheel error:", error);
    const status = error.message.includes("already exists") ? 409 : 500;
    res.status(status).json({ error: error.message });
  }
});

/**
 * POST /api/wheel/:id/join
 * Join an active spin wheel by paying entry fee.
 */
router.post("/:id/join", authenticate, async (req: AuthRequest, res) => {
  try {
    const result = await WheelService.joinWheel(req.user!.id, req.params.id as string);

    res.json({
      message: "Successfully joined the spin wheel.",
      ...result,
    });
  } catch (error: any) {
    console.error("Join wheel error:", error);
    const status = error.message.includes("Insufficient") ? 400
      : error.message.includes("already joined") ? 409
      : error.message.includes("Cannot join") ? 400
      : 500;
    res.status(status).json({ error: error.message });
  }
});

/**
 * POST /api/wheel/:id/start
 * Manually start a spin wheel. Admin only.
 */
router.post("/:id/start", authenticate, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const result = await WheelService.startWheel(req.params.id as string, req.user!.id);

    res.json({
      message: "Spin wheel started! Eliminations will begin.",
      ...result,
    });
  } catch (error: any) {
    console.error("Start wheel error:", error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/wheel/active
 * Get the current active spin wheel.
 */
router.get("/active", async (_req, res) => {
  try {
    const wheel = await WheelService.getActiveWheel();
    if (!wheel) {
      res.json({ message: "No active spin wheel.", wheel: null });
      return;
    }
    res.json({ wheel });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/wheel/history/list
 * Get completed/aborted wheel history.
 */
router.get("/history/list", authenticate, async (req: AuthRequest, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const history = await WheelService.getWheelHistory(limit);
    res.json({ history });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/wheel/config/current
 * Get current coin distribution configuration.
 */
router.get("/config/current", authenticate, requireAdmin, async (_req, res) => {
  try {
    const distribution = getCoinDistribution();
    res.json({
      distribution,
      entryFee: getConfig("default_entry_fee"),
      autoStartDelayMs: getConfig("auto_start_delay_ms"),
      eliminationIntervalMs: getConfig("elimination_interval_ms"),
      minParticipants: getConfig("min_participants"),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/wheel/config/update
 * Update coin distribution configuration. Admin only.
 */
router.put("/config/update", authenticate, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { winnerPoolPercent, adminPoolPercent, appPoolPercent, entryFee } = req.body;

    if (winnerPoolPercent !== undefined && adminPoolPercent !== undefined && appPoolPercent !== undefined) {
      const total = winnerPoolPercent + adminPoolPercent + appPoolPercent;
      if (Math.abs(total - 100) > 0.01) {
        res.status(400).json({
          error: `Distribution percentages must sum to 100. Current sum: ${total}`,
        });
        return;
      }
      await setConfig("winner_pool_percent", String(winnerPoolPercent), "Winner pool percentage");
      await setConfig("admin_pool_percent", String(adminPoolPercent), "Admin pool percentage");
      await setConfig("app_pool_percent", String(appPoolPercent), "App pool percentage");
    }

    if (entryFee !== undefined) {
      await setConfig("default_entry_fee", String(entryFee), "Default entry fee in coins");
    }

    await loadConfig();

    res.json({
      message: "Configuration updated successfully.",
      distribution: getCoinDistribution(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/wheel/:id
 * Get details of a specific spin wheel. Public access allowed for spectators.
 */
router.get("/:id", async (req, res) => {
  try {
    const wheel = await WheelService.getWheelById(req.params.id as string);
    res.json({ wheel });
  } catch (error: any) {
    res.status(404).json({ error: "Spin wheel not found." });
  }
});

export default router;
