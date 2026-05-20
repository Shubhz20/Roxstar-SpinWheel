import prisma from "./database.js";

// ─── Default configuration values ────────────────────────────────────────────
const DEFAULTS: Record<string, string> = {
  winner_pool_percent: process.env.WINNER_POOL_PERCENT || "70",
  admin_pool_percent: process.env.ADMIN_POOL_PERCENT || "20",
  app_pool_percent: process.env.APP_POOL_PERCENT || "10",
  default_entry_fee: process.env.DEFAULT_ENTRY_FEE || "100",
  auto_start_delay_ms: process.env.AUTO_START_DELAY_MS || "180000",   // 3 minutes
  elimination_interval_ms: process.env.ELIMINATION_INTERVAL_MS || "7000", // 7 seconds
  min_participants: process.env.MIN_PARTICIPANTS || "3",
};

// ─── Cached config (refreshed from DB) ───────────────────────────────────────
let configCache: Record<string, string> = { ...DEFAULTS };

/**
 * Load all configuration from the database, falling back to defaults.
 * Call this at server startup and whenever config changes.
 */
export async function loadConfig(): Promise<void> {
  try {
    const dbConfigs = await prisma.appConfig.findMany();
    // Start with defaults, overlay DB values
    configCache = { ...DEFAULTS };
    for (const cfg of dbConfigs) {
      configCache[cfg.key] = cfg.value;
    }
    console.log("✅ App configuration loaded from database");
  } catch (error) {
    console.warn("⚠️  Could not load config from DB, using defaults:", error);
    configCache = { ...DEFAULTS };
  }
}

/**
 * Get a configuration value by key.
 */
export function getConfig(key: string): string {
  return configCache[key] ?? DEFAULTS[key] ?? "";
}

/**
 * Get a numeric configuration value.
 */
export function getConfigNumber(key: string): number {
  return parseFloat(getConfig(key)) || 0;
}

/**
 * Update a configuration value in the database and cache.
 */
export async function setConfig(key: string, value: string, description?: string): Promise<void> {
  await prisma.appConfig.upsert({
    where: { key },
    update: { value, description },
    create: { key, value, description },
  });
  configCache[key] = value;
}

/**
 * Get the coin distribution percentages.
 * Validates they sum to 100.
 */
export function getCoinDistribution(): {
  winnerPercent: number;
  adminPercent: number;
  appPercent: number;
} {
  const winnerPercent = getConfigNumber("winner_pool_percent");
  const adminPercent = getConfigNumber("admin_pool_percent");
  const appPercent = getConfigNumber("app_pool_percent");

  const total = winnerPercent + adminPercent + appPercent;
  if (Math.abs(total - 100) > 0.01) {
    console.error(`⚠️  Coin distribution percentages sum to ${total}, not 100. Using defaults.`);
    return { winnerPercent: 70, adminPercent: 20, appPercent: 10 };
  }

  return { winnerPercent, adminPercent, appPercent };
}
