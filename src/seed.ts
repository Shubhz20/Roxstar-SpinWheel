import "dotenv/config";
import prisma from "./config/database.js";
import bcrypt from "bcryptjs";

/**
 * Database seed script.
 * Creates default admin, test users, and initial app configuration.
 */
async function seed(): Promise<void> {
  console.log("🌱 Seeding database...\n");

  // ─── Create App Configuration ──────────────────────────────────────────
  const configs = [
    { key: "winner_pool_percent", value: "70", description: "Percentage of entry fee going to winner pool" },
    { key: "admin_pool_percent", value: "20", description: "Percentage of entry fee going to admin/owner pool" },
    { key: "app_pool_percent", value: "10", description: "Percentage of entry fee going to app/platform pool" },
    { key: "default_entry_fee", value: "100", description: "Default entry fee in coins" },
    { key: "auto_start_delay_ms", value: "180000", description: "Auto-start delay in milliseconds (3 minutes)" },
    { key: "elimination_interval_ms", value: "7000", description: "Time between eliminations in milliseconds (7 seconds)" },
    { key: "min_participants", value: "3", description: "Minimum participants required to start a wheel" },
  ];

  for (const config of configs) {
    await prisma.appConfig.upsert({
      where: { key: config.key },
      update: { value: config.value, description: config.description },
      create: config,
    });
  }
  console.log("✅ App configuration seeded");

  // ─── Create Admin User ────────────────────────────────────────────────
  const adminPassword = await bcrypt.hash("admin123", 12);
  const admin = await prisma.user.upsert({
    where: { email: "admin@roxstar.com" },
    update: {},
    create: {
      username: "admin",
      email: "admin@roxstar.com",
      password: adminPassword,
      role: "admin",
      coins: 10000,
    },
  });
  console.log(`✅ Admin user created: ${admin.username} (${admin.email})`);

  // ─── Create Test Users ────────────────────────────────────────────────
  const testUsers = [
    { username: "player1", email: "player1@test.com" },
    { username: "player2", email: "player2@test.com" },
    { username: "player3", email: "player3@test.com" },
    { username: "player4", email: "player4@test.com" },
    { username: "player5", email: "player5@test.com" },
  ];

  const userPassword = await bcrypt.hash("password123", 12);

  for (const testUser of testUsers) {
    const user = await prisma.user.upsert({
      where: { email: testUser.email },
      update: {},
      create: {
        username: testUser.username,
        email: testUser.email,
        password: userPassword,
        role: "user",
        coins: 1000,
      },
    });
    console.log(`✅ Test user created: ${user.username} (${user.email}) - 1000 coins`);
  }

  console.log("\n🎉 Database seeding complete!");
  console.log("\n📋 Test Credentials:");
  console.log("   Admin:   admin@roxstar.com / admin123");
  console.log("   Players: player1@test.com ... player5@test.com / password123");
}

seed()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("❌ Seed error:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
