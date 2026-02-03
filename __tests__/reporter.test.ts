/**
 * Unit tests for TuningReporter notification delivery
 *
 * Tests that:
 *   - Formats notification messages with parameter, old/new values, reason, stats
 *   - Delivers via configured channel (log, telegram, discord, slack, none)
 *   - on-change: immediate notification
 *   - daily-summary: batches changes, sends once per day
 *   - weekly-summary: batches changes, sends once per week
 *   - Respects reporting.enabled setting
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Database } from "../db/sqlite.js";
import { TuningReporter } from "../services/reporter.js";
import type { TuningAdjustment, TierCounts } from "../core/tuning.js";
import { resolveConfig } from "../config.js";
import type { ResolvedConfig } from "../config.js";

/**
 * Create a temporary database file path
 */
function createTempDbPath(): string {
  const tempDir = os.tmpdir();
  return path.join(tempDir, `test-reporter-${randomUUID()}.db`);
}

/**
 * Create a test config with custom overrides
 */
function createTestConfig(overrides: Partial<ResolvedConfig["reporting"]> = {}): ResolvedConfig {
  const base = resolveConfig({});
  return {
    ...base,
    reporting: {
      ...base.reporting,
      ...overrides,
    },
  };
}

/**
 * Create a test adjustment
 */
function createTestAdjustment(overrides: Partial<TuningAdjustment> = {}): TuningAdjustment {
  return {
    parameter: "importanceThreshold",
    oldValue: 0.2,
    newValue: 0.25,
    reason: "HOT tier exceeded target (60 > 50)",
    ...overrides,
  };
}

/**
 * Create test tier counts
 */
function createTestTierCounts(overrides: Partial<TierCounts> = {}): TierCounts {
  return {
    hot: 60,
    warm: 100,
    cold: 50,
    archive: 10,
    total: 220,
    ...overrides,
  };
}

describe("TuningReporter", () => {
  let dbPath: string;
  let db: Database;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbPath = createTempDbPath();
    db = new Database(dbPath);
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    if (db && db.isOpen()) {
      db.close();
    }
    // Clean up temp database files
    try {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
      const walPath = dbPath + "-wal";
      const shmPath = dbPath + "-shm";
      if (fs.existsSync(walPath)) {
        fs.unlinkSync(walPath);
      }
      if (fs.existsSync(shmPath)) {
        fs.unlinkSync(shmPath);
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("report - enabled setting", () => {
    it("should skip reporting when disabled", () => {
      const config = createTestConfig({ enabled: false });
      const reporter = new TuningReporter(db.getDb(), config);

      const result = reporter.report(createTestAdjustment(), createTestTierCounts());

      expect(result.success).toBe(true);
      expect(result.channel).toBe("none");
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("should skip reporting when channel is none", () => {
      const config = createTestConfig({ enabled: true, channel: "none" });
      const reporter = new TuningReporter(db.getDb(), config);

      const result = reporter.report(createTestAdjustment(), createTestTierCounts());

      expect(result.success).toBe(true);
      expect(result.channel).toBe("none");
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe("report - on-change frequency", () => {
    it("should send immediate notification on change", () => {
      const config = createTestConfig({
        enabled: true,
        channel: "log",
        frequency: "on-change",
      });
      const reporter = new TuningReporter(db.getDb(), config);

      const result = reporter.report(createTestAdjustment(), createTestTierCounts());

      expect(result.success).toBe(true);
      expect(result.channel).toBe("log");
      expect(result.batched).toBeFalsy();
      expect(consoleSpy).toHaveBeenCalled();
    });

    it("should include parameter details in log output", () => {
      const config = createTestConfig({
        enabled: true,
        channel: "log",
        frequency: "on-change",
      });
      const reporter = new TuningReporter(db.getDb(), config);

      reporter.report(createTestAdjustment(), createTestTierCounts());

      const logOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("importanceThreshold");
      expect(logOutput).toContain("0.2");
      expect(logOutput).toContain("0.25");
      expect(logOutput).toContain("HOT tier exceeded target");
    });

    it("should include tier stats when includeMetrics is true", () => {
      const config = createTestConfig({
        enabled: true,
        channel: "log",
        frequency: "on-change",
        includeMetrics: true,
      });
      const reporter = new TuningReporter(db.getDb(), config);

      reporter.report(createTestAdjustment(), createTestTierCounts());

      const logOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("HOT: 60");
      expect(logOutput).toContain("WARM: 100");
      expect(logOutput).toContain("COLD: 50");
      expect(logOutput).toContain("Total: 220");
    });

    it("should not include tier stats when includeMetrics is false", () => {
      const config = createTestConfig({
        enabled: true,
        channel: "log",
        frequency: "on-change",
        includeMetrics: false,
      });
      const reporter = new TuningReporter(db.getDb(), config);

      reporter.report(createTestAdjustment(), createTestTierCounts());

      const logOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).not.toContain("HOT: 60");
      expect(logOutput).not.toContain("Tier Stats");
    });
  });

  describe("report - daily-summary frequency", () => {
    it("should batch notifications for daily summary", () => {
      const config = createTestConfig({
        enabled: true,
        channel: "log",
        frequency: "daily-summary",
      });
      const reporter = new TuningReporter(db.getDb(), config);

      const result = reporter.report(createTestAdjustment(), createTestTierCounts());

      expect(result.success).toBe(true);
      expect(result.batched).toBe(true);
      expect(reporter.getPendingCount()).toBe(1);
      // Should not have logged yet (batched)
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("should accumulate multiple pending notifications", () => {
      const config = createTestConfig({
        enabled: true,
        channel: "log",
        frequency: "daily-summary",
      });
      const reporter = new TuningReporter(db.getDb(), config);

      reporter.report(createTestAdjustment({ oldValue: 0.2, newValue: 0.25 }), createTestTierCounts());
      reporter.report(createTestAdjustment({ oldValue: 0.25, newValue: 0.3 }), createTestTierCounts());
      reporter.report(createTestAdjustment({ oldValue: 0.3, newValue: 0.35 }), createTestTierCounts());

      expect(reporter.getPendingCount()).toBe(3);
    });

    it("should flush pending notifications on demand", () => {
      const config = createTestConfig({
        enabled: true,
        channel: "log",
        frequency: "daily-summary",
      });
      const reporter = new TuningReporter(db.getDb(), config);

      reporter.report(createTestAdjustment({ oldValue: 0.2, newValue: 0.25 }), createTestTierCounts());
      reporter.report(createTestAdjustment({ oldValue: 0.25, newValue: 0.3 }), createTestTierCounts());

      const result = reporter.flushPending();

      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(reporter.getPendingCount()).toBe(0);
      expect(consoleSpy).toHaveBeenCalled();

      const logOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("Daily");
      expect(logOutput).toContain("2 change(s)");
    });
  });

  describe("report - weekly-summary frequency", () => {
    it("should batch notifications for weekly summary", () => {
      const config = createTestConfig({
        enabled: true,
        channel: "log",
        frequency: "weekly-summary",
      });
      const reporter = new TuningReporter(db.getDb(), config);

      const result = reporter.report(createTestAdjustment(), createTestTierCounts());

      expect(result.success).toBe(true);
      expect(result.batched).toBe(true);
      expect(reporter.getPendingCount()).toBe(1);
    });

    it("should flush as weekly summary", () => {
      const config = createTestConfig({
        enabled: true,
        channel: "log",
        frequency: "weekly-summary",
      });
      const reporter = new TuningReporter(db.getDb(), config);

      reporter.report(createTestAdjustment(), createTestTierCounts());
      reporter.flushPending();

      const logOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("Weekly");
    });
  });

  describe("formatSingleNotification", () => {
    it("should format notification with all fields", () => {
      const config = createTestConfig({ includeMetrics: true });
      const reporter = new TuningReporter(db.getDb(), config);

      const adjustment = createTestAdjustment();
      const tierCounts = createTestTierCounts();
      const timestamp = new Date().toISOString();

      const message = reporter.formatSingleNotification(adjustment, tierCounts, timestamp);

      expect(message.subject).toContain("importanceThreshold");
      expect(message.body).toContain("importanceThreshold");
      expect(message.body).toContain("0.2");
      expect(message.body).toContain("0.25");
      expect(message.body).toContain("HOT tier exceeded target");
      expect(message.body).toContain("HOT: 60");
      expect(message.createdAt).toBe(timestamp);
    });
  });

  describe("formatSummaryNotification", () => {
    it("should format summary with multiple adjustments", () => {
      const config = createTestConfig({ includeMetrics: true });
      const reporter = new TuningReporter(db.getDb(), config);

      const notifications = [
        {
          adjustment: createTestAdjustment({ oldValue: 0.2, newValue: 0.25 }),
          tierCounts: createTestTierCounts({ hot: 60 }),
          timestamp: "2026-02-03T10:00:00Z",
        },
        {
          adjustment: createTestAdjustment({ oldValue: 0.25, newValue: 0.3 }),
          tierCounts: createTestTierCounts({ hot: 55 }),
          timestamp: "2026-02-03T14:00:00Z",
        },
      ];

      const message = reporter.formatSummaryNotification("Daily", notifications);

      expect(message.subject).toContain("Daily");
      expect(message.subject).toContain("2 change(s)");
      expect(message.body).toContain("0.2");
      expect(message.body).toContain("0.25");
      expect(message.body).toContain("0.3");
      expect(message.body).toContain("HOT=60");
      expect(message.body).toContain("HOT=55");
    });
  });

  describe("channel fallback", () => {
    it("should fall back to log when telegram is not configured", () => {
      // Ensure env vars are not set
      const originalToken = process.env.TELEGRAM_BOT_TOKEN;
      const originalChat = process.env.TELEGRAM_CHAT_ID;
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;

      const config = createTestConfig({
        enabled: true,
        channel: "telegram",
        frequency: "on-change",
      });
      const reporter = new TuningReporter(db.getDb(), config);

      reporter.report(createTestAdjustment(), createTestTierCounts());

      // Should have fallen back to log
      expect(consoleSpy).toHaveBeenCalled();
      const logOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("Telegram not configured");

      // Restore env vars
      if (originalToken) process.env.TELEGRAM_BOT_TOKEN = originalToken;
      if (originalChat) process.env.TELEGRAM_CHAT_ID = originalChat;
    });

    it("should fall back to log when discord is not configured", () => {
      const originalUrl = process.env.DISCORD_WEBHOOK_URL;
      delete process.env.DISCORD_WEBHOOK_URL;

      const config = createTestConfig({
        enabled: true,
        channel: "discord",
        frequency: "on-change",
      });
      const reporter = new TuningReporter(db.getDb(), config);

      reporter.report(createTestAdjustment(), createTestTierCounts());

      expect(consoleSpy).toHaveBeenCalled();
      const logOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("Discord not configured");

      if (originalUrl) process.env.DISCORD_WEBHOOK_URL = originalUrl;
    });

    it("should fall back to log when slack is not configured", () => {
      const originalUrl = process.env.SLACK_WEBHOOK_URL;
      delete process.env.SLACK_WEBHOOK_URL;

      const config = createTestConfig({
        enabled: true,
        channel: "slack",
        frequency: "on-change",
      });
      const reporter = new TuningReporter(db.getDb(), config);

      reporter.report(createTestAdjustment(), createTestTierCounts());

      expect(consoleSpy).toHaveBeenCalled();
      const logOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("Slack not configured");

      if (originalUrl) process.env.SLACK_WEBHOOK_URL = originalUrl;
    });
  });

  describe("flushPending", () => {
    it("should return null when no pending notifications", () => {
      const config = createTestConfig({
        enabled: true,
        channel: "log",
        frequency: "daily-summary",
      });
      const reporter = new TuningReporter(db.getDb(), config);

      const result = reporter.flushPending();

      expect(result).toBeNull();
    });

    it("should clear pending after flush", () => {
      const config = createTestConfig({
        enabled: true,
        channel: "log",
        frequency: "daily-summary",
      });
      const reporter = new TuningReporter(db.getDb(), config);

      reporter.report(createTestAdjustment(), createTestTierCounts());
      expect(reporter.getPendingCount()).toBe(1);

      reporter.flushPending();
      expect(reporter.getPendingCount()).toBe(0);
    });
  });
});
