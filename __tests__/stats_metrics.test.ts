/**
 * Tests for US-021: memory_stats --metrics dashboard
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3, { type Database as SqliteDb } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { MemoryStatsCommand } from "../cli/stats.js";
import type { ResolvedConfig } from "../config.js";
import { Tier, MemoryType } from "../core/types.js";

// Mock embedding provider
const mockEmbeddingProvider = {
  getModelName: () => "mock-model",
  getDimensions: () => 384,
  embed: async (text: string) => new Array(384).fill(0).map(() => Math.random()),
};

// Test config with tuning settings
const testConfig: ResolvedConfig = {
  embedding: {
    provider: "local",
    model: "mock-model",
    apiKey: undefined,
    local: { modelPath: "mock-path" },
  },
  dbPath: ":memory:",
  autoCapture: true,
  autoRecall: {
    enabled: true,
    minScore: 0.2,
    maxItems: 20,
    budgets: { pinned: 25, hot: 45, warm: 25, cold: 5 },
  },
  tiers: {
    hot: { ttlHours: 72 },
    warm: { demotionDays: 60 },
    cold: { promotionUses: 3, promotionDays: 2 },
  },
  scoring: { similarity: 0.5, recency: 0.3, frequency: 0.2 },
  injection: {
    maxItems: 20,
    minScore: 0.2,
    budgets: { pinned: 25, hot: 45, warm: 25, cold: 5 },
  },
  decay: {
    intervalHours: 6,
    default: { hotTTL: 72, warmTTL: 60 },
    overrides: {},
  },
  context: { ttlHours: 4 },
  sessions: {
    main: { defaultTier: "HOT", autoCapture: true, autoInject: true },
    cron: { defaultTier: "COLD", autoCapture: false, autoInject: true },
    spawned: { defaultTier: "WARM", autoCapture: false, autoInject: true },
  },
  tuning: {
    enabled: true,
    mode: "hybrid",
    lockDurationDays: 7,
    autoAdjust: {
      importanceThreshold: { min: 0.1, max: 0.9, step: 0.05 },
      hotTargetSize: { min: 10, max: 50 },
      warmTargetSize: { min: 50, max: 200 },
    },
  },
  reporting: {
    enabled: true,
    channel: "log",
    frequency: "on-change",
    includeMetrics: true,
  },
};

describe("US-021: memory_stats --metrics dashboard", () => {
  let db: SqliteDb;

  beforeEach(() => {
    db = new BetterSqlite3(":memory:");

    // Create minimal schema for testing
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        importance REAL DEFAULT 0.5,
        category TEXT,
        created_at TEXT NOT NULL,
        tier TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        do_not_inject INTEGER DEFAULT 0,
        pinned INTEGER DEFAULT 0,
        use_count INTEGER DEFAULT 0,
        last_accessed_at TEXT NOT NULL,
        use_days TEXT DEFAULT '[]',
        source TEXT,
        parent_id TEXT
      );

      CREATE TABLE IF NOT EXISTS current_context (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ttl_seconds INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS injection_feedback (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        injected_at TEXT NOT NULL,
        access_frequency INTEGER DEFAULT 0,
        session_outcome TEXT,
        injection_density REAL NOT NULL,
        decay_resistance REAL,
        proxy_score REAL,
        agent_score REAL,
        agent_notes TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tuning_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        parameter TEXT NOT NULL,
        old_value TEXT NOT NULL,
        new_value TEXT NOT NULL,
        reason TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('auto', 'agent', 'user')),
        user_override_until TEXT,
        reverted INTEGER DEFAULT 0
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  // Helper functions
  function insertMemory(tier: Tier, memoryType: MemoryType = MemoryType.factual) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO memories (id, text, importance, created_at, tier, memory_type, do_not_inject, pinned, use_count, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?)
    `).run(randomUUID(), `Test memory ${Math.random()}`, 0.5, now, tier, memoryType, now);
  }

  function insertInjectionFeedback(memoryId: string, accessFrequency: number, proxyScore: number | null) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO injection_feedback (id, memory_id, session_key, injected_at, access_frequency, injection_density, proxy_score, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), memoryId, "test-session", now, accessFrequency, 0.5, proxyScore, now);
  }

  function insertTuningLog(parameter: string, oldValue: number, newValue: number, reason: string, source: "auto" | "agent" | "user", lockUntil?: string) {
    db.prepare(`
      INSERT INTO tuning_log (id, timestamp, parameter, old_value, new_value, reason, source, user_override_until, reverted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(randomUUID(), new Date().toISOString(), parameter, JSON.stringify(oldValue), JSON.stringify(newValue), reason, source, lockUntil ?? null);
  }

  describe("execute with --metrics option", () => {
    it("should include metricsDashboard in result when metrics=true", async () => {
      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ json: true, metrics: true });
      const parsed = JSON.parse(result);

      expect(parsed.metricsDashboard).toBeDefined();
      expect(parsed.metricsDashboard.injectionUsefulness).toBeDefined();
      expect(parsed.metricsDashboard.configVsTargets).toBeDefined();
      expect(parsed.metricsDashboard.recentTuningLogs).toBeDefined();
    });

    it("should NOT include metricsDashboard when metrics=false", async () => {
      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ json: true, metrics: false });
      const parsed = JSON.parse(result);

      expect(parsed.metricsDashboard).toBeUndefined();
    });

    it("should NOT include metricsDashboard when metrics is not specified", async () => {
      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ json: true });
      const parsed = JSON.parse(result);

      expect(parsed.metricsDashboard).toBeUndefined();
    });
  });

  describe("injection usefulness summary", () => {
    it("should return zero counts when no injection_feedback exists", async () => {
      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ json: true, metrics: true });
      const parsed = JSON.parse(result);

      expect(parsed.metricsDashboard.injectionUsefulness.totalInjections).toBe(0);
      expect(parsed.metricsDashboard.injectionUsefulness.avgAccessFrequency).toBe(0);
    });

    it("should calculate avg proxy_score from injection_feedback", async () => {
      const memoryId = randomUUID();
      insertInjectionFeedback(memoryId, 3, 0.8);
      insertInjectionFeedback(memoryId, 2, 0.6);
      insertInjectionFeedback(memoryId, 1, 0.4);

      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ json: true, metrics: true });
      const parsed = JSON.parse(result);

      expect(parsed.metricsDashboard.injectionUsefulness.totalInjections).toBe(3);
      expect(parsed.metricsDashboard.injectionUsefulness.avgProxyScore).toBeCloseTo(0.6, 2);
    });

    it("should calculate avg access_frequency", async () => {
      const memoryId = randomUUID();
      insertInjectionFeedback(memoryId, 10, null);
      insertInjectionFeedback(memoryId, 5, null);
      insertInjectionFeedback(memoryId, 0, null);

      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ json: true, metrics: true });
      const parsed = JSON.parse(result);

      expect(parsed.metricsDashboard.injectionUsefulness.avgAccessFrequency).toBe(5);
    });

    it("should count tuning adjustments", async () => {
      insertTuningLog("importanceThreshold", 0.2, 0.25, "HOT tier exceeded target", "auto");
      insertTuningLog("importanceThreshold", 0.25, 0.3, "HOT tier exceeded target", "auto");
      // This one shouldn't count - same value (user lock)
      insertTuningLog("importanceThreshold", 0.3, 0.3, "User locked parameter", "user");

      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ json: true, metrics: true });
      const parsed = JSON.parse(result);

      expect(parsed.metricsDashboard.injectionUsefulness.adjustmentCount).toBe(2);
    });
  });

  describe("config vs targets", () => {
    it("should show current importance threshold from config default when no tuning_log", async () => {
      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ json: true, metrics: true });
      const parsed = JSON.parse(result);

      expect(parsed.metricsDashboard.configVsTargets.currentImportanceThreshold).toBe(0.2);
    });

    it("should show current importance threshold from tuning_log when present", async () => {
      insertTuningLog("importanceThreshold", 0.2, 0.35, "HOT tier exceeded target", "auto");

      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ json: true, metrics: true });
      const parsed = JSON.parse(result);

      expect(parsed.metricsDashboard.configVsTargets.currentImportanceThreshold).toBe(0.35);
    });

    it("should show HOT tier count vs target range", async () => {
      // Add 25 HOT memories
      for (let i = 0; i < 25; i++) {
        insertMemory(Tier.HOT);
      }

      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ json: true, metrics: true });
      const parsed = JSON.parse(result);

      expect(parsed.metricsDashboard.configVsTargets.hotTierCount).toBe(25);
      expect(parsed.metricsDashboard.configVsTargets.hotTargetRange.min).toBe(10);
      expect(parsed.metricsDashboard.configVsTargets.hotTargetRange.max).toBe(50);
    });

    it("should show WARM tier count vs target range", async () => {
      // Add 100 WARM memories
      for (let i = 0; i < 100; i++) {
        insertMemory(Tier.WARM);
      }

      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ json: true, metrics: true });
      const parsed = JSON.parse(result);

      expect(parsed.metricsDashboard.configVsTargets.warmTierCount).toBe(100);
      expect(parsed.metricsDashboard.configVsTargets.warmTargetRange.min).toBe(50);
      expect(parsed.metricsDashboard.configVsTargets.warmTargetRange.max).toBe(200);
    });

    it("should show importance threshold bounds", async () => {
      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ json: true, metrics: true });
      const parsed = JSON.parse(result);

      expect(parsed.metricsDashboard.configVsTargets.importanceThresholdBounds.min).toBe(0.1);
      expect(parsed.metricsDashboard.configVsTargets.importanceThresholdBounds.max).toBe(0.9);
      expect(parsed.metricsDashboard.configVsTargets.importanceThresholdBounds.step).toBe(0.05);
    });
  });

  describe("recent tuning logs", () => {
    it("should return empty array when no tuning_log entries exist", async () => {
      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ json: true, metrics: true });
      const parsed = JSON.parse(result);

      expect(parsed.metricsDashboard.recentTuningLogs).toEqual([]);
    });

    it("should return recent tuning entries with formatted values", async () => {
      insertTuningLog("importanceThreshold", 0.2, 0.25, "HOT tier exceeded target (45 > 30)", "auto");

      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ json: true, metrics: true });
      const parsed = JSON.parse(result);

      expect(parsed.metricsDashboard.recentTuningLogs.length).toBe(1);
      const entry = parsed.metricsDashboard.recentTuningLogs[0];
      expect(entry.parameter).toBe("importanceThreshold");
      expect(entry.oldValue).toBe("0.20");
      expect(entry.newValue).toBe("0.25");
      expect(entry.reason).toBe("HOT tier exceeded target (45 > 30)");
      expect(entry.source).toBe("auto");
      expect(entry.isLocked).toBe(false);
    });

    it("should mark entries as locked when user_override_until is in the future", async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);

      insertTuningLog("importanceThreshold", 0.3, 0.3, "User locked parameter", "user", futureDate.toISOString());

      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ json: true, metrics: true });
      const parsed = JSON.parse(result);

      expect(parsed.metricsDashboard.recentTuningLogs[0].isLocked).toBe(true);
    });

    it("should NOT mark entries as locked when user_override_until is in the past", async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      insertTuningLog("importanceThreshold", 0.3, 0.3, "User locked parameter", "user", pastDate.toISOString());

      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ json: true, metrics: true });
      const parsed = JSON.parse(result);

      expect(parsed.metricsDashboard.recentTuningLogs[0].isLocked).toBe(false);
    });

    it("should limit to 10 most recent entries", async () => {
      // Insert 15 entries
      for (let i = 0; i < 15; i++) {
        insertTuningLog("importanceThreshold", 0.2 + i * 0.01, 0.2 + (i + 1) * 0.01, `Adjustment ${i}`, "auto");
      }

      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ json: true, metrics: true });
      const parsed = JSON.parse(result);

      expect(parsed.metricsDashboard.recentTuningLogs.length).toBe(10);
    });
  });

  describe("text output formatting", () => {
    it("should include metrics dashboard in text output when metrics=true", async () => {
      insertTuningLog("importanceThreshold", 0.2, 0.25, "HOT tier exceeded target", "auto");

      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ metrics: true });

      expect(result).toContain("Tuning Metrics Dashboard");
      expect(result).toContain("Injection Usefulness Summary");
      expect(result).toContain("Current Config vs Targets");
      expect(result).toContain("Recent Tuning Changes");
    });

    it("should NOT include metrics dashboard in text output when metrics=false", async () => {
      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ metrics: false });

      expect(result).not.toContain("Tuning Metrics Dashboard");
    });

    it("should show tier status indicators (OK, ABOVE, BELOW)", async () => {
      // Add 60 HOT memories (above max of 50)
      for (let i = 0; i < 60; i++) {
        insertMemory(Tier.HOT);
      }

      const command = new MemoryStatsCommand(db, ":memory:", mockEmbeddingProvider as any, testConfig);
      const result = await command.execute({ metrics: true });

      expect(result).toContain("[ABOVE]");
    });
  });
});
