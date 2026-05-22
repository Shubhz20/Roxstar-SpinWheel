import "dotenv/config";
import assert from "node:assert";
import prisma from "../config/database.js";
import { WheelService } from "../services/wheelService.js";
import { CoinService } from "../services/coinService.js";
import { loadConfig } from "../config/appConfig.js";

/**
 * Robust automated integration test suite for the Spin Wheel Game System.
 * Tests critical path, atomic transactions, edge cases, and serverless drive-by logic.
 */
async function runTests() {
  console.log("🧪 Starting Spin Wheel System Critical Path Tests...\n");

  try {
    // 1. Setup
    await prisma.$connect();
    await loadConfig();

    console.log("🧹 Cleaning up old active/test wheels and transactions...");
    // Archive or delete old active wheels to prevent lobby blocks
    await prisma.spinWheel.updateMany({
      where: { status: { in: ["waiting", "active", "spinning"] } },
      data: { status: "aborted" },
    });

    // Create unique test users
    console.log("👤 Creating/resetting test users...");
    const adminUser = await prisma.user.upsert({
      where: { email: "test_admin@roxstar.com" },
      update: { coins: 10000, role: "admin" },
      create: {
        username: "test_admin",
        email: "test_admin@roxstar.com",
        password: "hashed_password_placeholder",
        role: "admin",
        coins: 10000,
      },
    });

    const players = [];
    for (let i = 1; i <= 3; i++) {
      const player = await prisma.user.upsert({
        where: { email: `test_player${i}@test.com` },
        update: { coins: 1000 },
        create: {
          username: `test_player${i}`,
          email: `test_player${i}@test.com`,
          password: "hashed_password_placeholder",
          role: "user",
          coins: 1000,
        },
      });
      players.push(player);
    }

    const poorPlayer = await prisma.user.upsert({
      where: { email: "test_poor@test.com" },
      update: { coins: 10 },
      create: {
        username: "test_poor",
        email: "test_poor@test.com",
        password: "hashed_password_placeholder",
        role: "user",
        coins: 10,
      },
    });

    console.log("✅ Test setup complete.\n");

    // ─────────────────────────────────────────────────────────────────────────
    // TEST CASE 1: Create Active Spin Wheel & Single Active Wheel Enforcer
    // ─────────────────────────────────────────────────────────────────────────
    console.log("🏃 Test Case 1: Creating active spin wheel and validating uniqueness...");
    
    const wheel1 = await WheelService.createWheel(adminUser.id, 100);
    assert.strictEqual(wheel1.status, "waiting", "Newly created wheel should be in 'waiting' state");
    assert.strictEqual(wheel1.entryFee, 100, "Entry fee should match requested fee");
    assert.strictEqual(wheel1.adminId, adminUser.id, "Admin ID should match creator");

    // Try to create another active wheel while one exists
    try {
      await WheelService.createWheel(adminUser.id, 100);
      assert.fail("Should not allow creating a second active spin wheel");
    } catch (error: any) {
      assert.ok(
        error.message.includes("An active spin wheel already exists"),
        `Error message should indicate active wheel already exists, got: ${error.message}`
      );
    }
    console.log("✅ Test Case 1 passed!\n");

    // ─────────────────────────────────────────────────────────────────────────
    // TEST CASE 2: Join Spin Wheel, Validation & Atomic Fee Splits
    // ─────────────────────────────────────────────────────────────────────────
    console.log("🏃 Test Case 2: Joining spin wheel, balance checks, and pool distributions...");
    
    // Player 1 joins
    const join1 = await WheelService.joinWheel(players[0].id, wheel1.id);
    assert.strictEqual(join1.totalParticipants, 1, "Total participants should be 1");
    
    // Check Player 1 balance deduction
    const p1Balance = await CoinService.getBalance(players[0].id);
    assert.strictEqual(p1Balance, 900, "Player 1 coins should be 1000 - 100 = 900");

    // Check pool splits in DB (70% winner, 20% admin, 10% app)
    const dbWheel1 = await prisma.spinWheel.findUniqueOrThrow({ where: { id: wheel1.id } });
    assert.strictEqual(dbWheel1.winnerPool, 70, "Winner pool should have 70 coins");
    assert.strictEqual(dbWheel1.adminPool, 20, "Admin pool should have 20 coins");
    assert.strictEqual(dbWheel1.appPool, 10, "App pool should have 10 coins");

    // Try to join twice (should fail)
    try {
      await WheelService.joinWheel(players[0].id, wheel1.id);
      assert.fail("Player should not be allowed to join the same wheel twice");
    } catch (error: any) {
      assert.ok(
        error.message.includes("already joined"),
        `Should reject duplicate joins, got: ${error.message}`
      );
    }

    // Admin tries to join (should fail)
    try {
      await WheelService.joinWheel(adminUser.id, wheel1.id);
      assert.fail("Admin should not be allowed to join their own wheel");
    } catch (error: any) {
      assert.ok(
        error.message.includes("Admin cannot join"),
        `Should reject admin joins, got: ${error.message}`
      );
    }

    // Poor player tries to join (should fail)
    try {
      await WheelService.joinWheel(poorPlayer.id, wheel1.id);
      assert.fail("User with insufficient balance should not be allowed to join");
    } catch (error: any) {
      assert.ok(
        error.message.includes("Insufficient coins"),
        `Should reject user with insufficient coins, got: ${error.message}`
      );
    }
    console.log("✅ Test Case 2 passed!\n");

    // ─────────────────────────────────────────────────────────────────────────
    // TEST CASE 3: Auto-abort & Atomic Refunds
    // ─────────────────────────────────────────────────────────────────────────
    console.log("🏃 Test Case 3: Triggering auto-abort and validating atomic refunds...");
    
    // Trigger auto-start/abort. Since only 1 player joined (< 3 min), it should abort & refund.
    const abortResult = await WheelService.autoStartOrAbort(wheel1.id);
    assert.strictEqual(abortResult.action, "aborted", "Action should be aborted");
    assert.strictEqual(abortResult.refundCount, 1, "1 refund should be processed");

    // Verify Player 1 balance is fully refunded
    const p1BalanceAfterAbort = await CoinService.getBalance(players[0].id);
    assert.strictEqual(p1BalanceAfterAbort, 1000, "Player 1 coins should be restored to 1000");

    // Verify wheel pools reset and status is aborted
    const dbWheel1Aborted = await prisma.spinWheel.findUniqueOrThrow({ where: { id: wheel1.id } });
    assert.strictEqual(dbWheel1Aborted.status, "aborted", "Wheel status should be aborted");
    assert.strictEqual(dbWheel1Aborted.winnerPool, 0, "Winner pool should be reset to 0");
    assert.strictEqual(dbWheel1Aborted.adminPool, 0, "Admin pool should be reset to 0");
    assert.strictEqual(dbWheel1Aborted.appPool, 0, "App pool should be reset to 0");

    // Verify transaction logs
    const refundTx = await prisma.transaction.findFirst({
      where: { userId: players[0].id, spinWheelId: wheel1.id, type: "refund" },
    });
    assert.ok(refundTx, "Refund transaction log should exist");
    assert.strictEqual(refundTx.amount, 100, "Refund amount should be positive 100");
    console.log("✅ Test Case 3 passed!\n");

    // ─────────────────────────────────────────────────────────────────────────
    // TEST CASE 4: Manual Start with Minimum Participants Enforced
    // ─────────────────────────────────────────────────────────────────────────
    console.log("🏃 Test Case 4: Creating new wheel and manually starting with 3 players...");
    
    const wheel2 = await WheelService.createWheel(adminUser.id, 100);
    
    // Have Player 1 and Player 2 join (total 2 players)
    await WheelService.joinWheel(players[0].id, wheel2.id);
    await WheelService.joinWheel(players[1].id, wheel2.id);

    // Try starting with 2 players (should fail, min is 3)
    try {
      await WheelService.startWheel(wheel2.id, adminUser.id);
      assert.fail("Should not allow starting wheel with less than 3 participants");
    } catch (error: any) {
      assert.ok(
        error.message.includes("Minimum 3 participants required"),
        `Should reject start with <3 players, got: ${error.message}`
      );
    }

    // Player 3 joins (total 3 players)
    await WheelService.joinWheel(players[2].id, wheel2.id);

    // Try starting with non-admin (should fail)
    try {
      await WheelService.startWheel(wheel2.id, players[0].id);
      assert.fail("Non-admin should not be allowed to start the wheel");
    } catch (error: any) {
      assert.ok(
        error.message.includes("Only the wheel creator can start"),
        `Should reject non-admin start, got: ${error.message}`
      );
    }

    // Start wheel successfully
    const startResult = await WheelService.startWheel(wheel2.id, adminUser.id);
    assert.strictEqual(startResult.wheel.status, "spinning", "Wheel status should be 'spinning'");
    assert.strictEqual(startResult.totalParticipants, 3, "Total participants should be 3");
    
    const dbWheel2 = await prisma.spinWheel.findUniqueOrThrow({ where: { id: wheel2.id } });
    assert.ok(dbWheel2.startedAt, "startedAt timestamp should be set");
    assert.ok(dbWheel2.eliminationOrder, "eliminationOrder array should be populated");
    
    const order = JSON.parse(dbWheel2.eliminationOrder);
    assert.strictEqual(order.length, 3, "Elimination order should have 3 user IDs");
    console.log("✅ Test Case 4 passed!\n");

    // ─────────────────────────────────────────────────────────────────────────
    // TEST CASE 5: Real-Time Elimination & Winner Payout Atomicity
    // ─────────────────────────────────────────────────────────────────────────
    console.log("🏃 Test Case 5: Running real-time eliminations to completion and verifying payout...");
    
    // Store starting balances
    const adminStartBalance = await CoinService.getBalance(adminUser.id);

    // First elimination
    const elim1 = await WheelService.eliminateNext(wheel2.id);
    assert.ok(elim1.eliminated, "Should have eliminated a player");
    assert.strictEqual(elim1.winner, null, "Should not have a winner yet");
    assert.strictEqual(elim1.remainingCount, 2, "2 players should remain");
    assert.strictEqual(elim1.isComplete, false, "Game should not be complete");

    // Verify participant status in database
    const dbP1 = await prisma.participant.findUniqueOrThrow({
      where: { userId_spinWheelId: { userId: elim1.eliminated.userId, spinWheelId: wheel2.id } },
    });
    assert.strictEqual(dbP1.status, "eliminated", "Participant should be marked eliminated");
    assert.ok(dbP1.eliminatedAt, "eliminatedAt timestamp should be set");

    // Second (and final) elimination
    const elim2 = await WheelService.eliminateNext(wheel2.id);
    assert.ok(elim2.eliminated, "Should have eliminated another player");
    assert.ok(elim2.winner, "Should determine a winner");
    assert.strictEqual(elim2.remainingCount, 1, "1 player should remain");
    assert.strictEqual(elim2.isComplete, true, "Game should be complete");

    // Verify wheel is completed
    const completedWheel = await prisma.spinWheel.findUniqueOrThrow({ where: { id: wheel2.id } });
    assert.strictEqual(completedWheel.status, "completed", "Wheel status should be 'completed'");
    assert.strictEqual(completedWheel.winnerId, elim2.winner.userId, "Winner ID should match in DB");
    assert.ok(completedWheel.completedAt, "completedAt timestamp should be set");

    // Verify balances (winner pool = 210, admin pool = 60, app pool = 30)
    // Winner gets 210, admin gets 60, app pool goes to app (recorded under admin but not in wallet, or as per spec: credits admin with admin pool)
    const winnerFinalBalance = await CoinService.getBalance(elim2.winner.userId);
    // Winner originally paid 100, leaving 900. Gets +210 = 1110.
    assert.strictEqual(winnerFinalBalance, 1110, "Winner should have 1110 coins");

    const adminFinalBalance = await CoinService.getBalance(adminUser.id);
    assert.strictEqual(adminFinalBalance - adminStartBalance, 60, "Admin should receive +60 coins");

    // Verify transaction logs
    const winnerPayoutTx = await prisma.transaction.findFirst({
      where: { userId: elim2.winner.userId, spinWheelId: wheel2.id, type: "winner_payout" },
    });
    assert.ok(winnerPayoutTx, "Winner payout transaction log should exist");
    assert.strictEqual(winnerPayoutTx.amount, 210, "Winner payout amount should be +210");

    const adminPayoutTx = await prisma.transaction.findFirst({
      where: { userId: adminUser.id, spinWheelId: wheel2.id, type: "admin_payout" },
    });
    assert.ok(adminPayoutTx, "Admin payout transaction log should exist");
    assert.strictEqual(adminPayoutTx.amount, 60, "Admin payout amount should be +60");

    const appFeeTx = await prisma.transaction.findFirst({
      where: { userId: adminUser.id, spinWheelId: wheel2.id, type: "app_fee" },
    });
    assert.ok(appFeeTx, "App platform fee transaction log should exist");
    assert.strictEqual(appFeeTx.amount, 30, "App fee amount should be +30");
    
    console.log("✅ Test Case 5 passed!\n");

    // ─────────────────────────────────────────────────────────────────────────
    // TEST CASE 6: Serverless Drive-By Progression Logic
    // ─────────────────────────────────────────────────────────────────────────
    console.log("🏃 Test Case 6: Verifying serverless drive-by progression triggers...");
    
    // Part A: Waiting Lobby Expiration (Auto-abort because < 3 players and 3 minutes elapsed)
    console.log("   👉 Part A: Expiring waiting lobby auto-abort...");

    // Capture balances BEFORE joining wheel 3
    const p1CoinsBeforeW3 = await CoinService.getBalance(players[0].id);
    const p2CoinsBeforeW3 = await CoinService.getBalance(players[1].id);

    const wheel3 = await WheelService.createWheel(adminUser.id, 100);
    await WheelService.joinWheel(players[0].id, wheel3.id);
    await WheelService.joinWheel(players[1].id, wheel3.id); // 2 players joined

    // Verify deductions happened
    const p1CoinsAfterJoinW3 = await CoinService.getBalance(players[0].id);
    assert.strictEqual(p1CoinsAfterJoinW3, p1CoinsBeforeW3 - 100, "Player 1 should have paid 100 entry fee");

    // Manually force createdAt to be 4 minutes ago in the database
    const fourMinutesAgo = new Date(Date.now() - 4 * 60 * 1000);
    await prisma.spinWheel.update({
      where: { id: wheel3.id },
      data: { createdAt: fourMinutesAgo },
    });

    // Request active wheel. This should trigger the drive-by progression!
    const activeWheelResult = await WheelService.getActiveWheel();
    assert.strictEqual(activeWheelResult, null, "Should return null since active wheel was drive-by aborted");

    const archivedWheel3 = await prisma.spinWheel.findUniqueOrThrow({ where: { id: wheel3.id } });
    assert.strictEqual(archivedWheel3.status, "aborted", "Wheel 3 should be aborted automatically");
    
    // Check refunds (balance should be restored to pre-join value)
    const p1CoinsAfterRefund = await CoinService.getBalance(players[0].id);
    assert.strictEqual(p1CoinsAfterRefund, p1CoinsBeforeW3, "Player 1 should be fully refunded to pre-join balance");
    const p2CoinsAfterRefund = await CoinService.getBalance(players[1].id);
    assert.strictEqual(p2CoinsAfterRefund, p2CoinsBeforeW3, "Player 2 should be fully refunded to pre-join balance");

    // Part B: Spinning Elimination Expiration (Drive-by elimination intervals)
    console.log("   👉 Part B: Expiring spinning elimination sequence...");
    const wheel4 = await WheelService.createWheel(adminUser.id, 100);
    await WheelService.joinWheel(players[0].id, wheel4.id);
    await WheelService.joinWheel(players[1].id, wheel4.id);
    await WheelService.joinWheel(players[2].id, wheel4.id); // 3 players joined

    // Start it
    await WheelService.startWheel(wheel4.id, adminUser.id);
    
    // Manually force updatedAt to be 10 seconds ago (elimination interval is 7 seconds)
    const tenSecondsAgo = new Date(Date.now() - 10000);
    await prisma.spinWheel.update({
      where: { id: wheel4.id },
      data: { updatedAt: tenSecondsAgo },
    });

    // Request active wheel. Should trigger drive-by elimination of ONE player.
    const spinningResult1 = await WheelService.getActiveWheel();
    assert.ok(spinningResult1, "Spinning wheel should still be active");
    assert.strictEqual(spinningResult1.status, "spinning", "Status should still be spinning");
    
    const activeParticipants1 = spinningResult1.participants.filter((p: any) => p.status === "active");
    assert.strictEqual(activeParticipants1.length, 2, "Active participants should be reduced from 3 to 2");

    // Force updatedAt again
    await prisma.spinWheel.update({
      where: { id: wheel4.id },
      data: { updatedAt: tenSecondsAgo },
    });

    // Request active wheel. Should trigger the second and final elimination, determining the winner and completing!
    const spinningResult2 = await WheelService.getActiveWheel();
    assert.strictEqual(spinningResult2, null, "Should return null as the wheel is completed and no longer active");

    const completedWheel4 = await prisma.spinWheel.findUniqueOrThrow({ where: { id: wheel4.id } });
    assert.strictEqual(completedWheel4.status, "completed", "Wheel 4 should be drive-by completed");
    assert.ok(completedWheel4.winnerId, "Winner should be set");
    console.log("✅ Test Case 6 passed!\n");

    console.log("🎉 All 6 Integration Test Cases Passed Successfully!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Test execution failed with error:", error);
    process.exit(1);
  }
}

runTests();
