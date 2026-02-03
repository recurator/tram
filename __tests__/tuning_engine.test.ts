/**
 * Unit tests for TuningEngine auto-adjustment logic
 *
 * Tests that:
 *   - TuningEngine checks tier sizes during run
 *   - If HOT > hotTargetSize.max, increases importanceThreshold by step
 *   - If HOT < hotTargetSize.min, decreases importanceThreshold by step
 *   - Respects tuning.autoAdjust bounds (never exceed min/max)
 *   - Only adjusts when tuning.mode is 'auto' or 'hybrid'
 *   - Skips locked parameters
 *   - Logs changes to tuning_log table
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Database } from "../db/sqlite.js";
import { TuningEngine } from "../core/tuning.js";
import { Tier, MemoryType, type Memory } from "../core/types.js";
import { resolveConfig } from "../config.js";
import type { ResolvedConfig } from "../config.js";

/**
 * Create a temporary database file path
 */
function createTempDbPath(): string {
  const tempDir = os.tmpdir();
  return path.join(tempDir, `test-tuning-${randomUUID()}.db`);
}

/**
 * Create a test memory with sensible defaults
 */
function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    text: "Test memory content",
    importance: 0.5,
    category: null,
    created_at: now,
    tier: Tier.HOT,
    memory_type: MemoryType.factual,
    do_not_inject: false,
    pinned: false,
    use_count: 0,
    last_accessed_at: now,
    use_days: [],
    source: null,
    parent_id: null,
    ...overrides,
  };
}

/**
 * Insert a memory into the database using raw SQL
 */
function insertMemory(db: Database, memory: Memory): void {
  const sqliteDb = db.getDb();
  const insertStmt = sqliteDb.prepare(`
    INSERT INTO memories (id, text, importance, category, created_at, tier, memory_type, do_not_inject, pinned, use_count, last_accessed_at, use_days, source, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertStmt.run(
    memory.id,
    memory.text,
    memory.importance,
    memory.category,
    memory.created_at,
    memory.tier,
    memory.memory_type,
    memory.do_not_inject ? 1 : 0,
    memory.pinned ? 1 : 0,
    memory.use_count,
    memory.last_accessed_at,
    JSON.stringify(memory.use_days),
    memory.source,
    memory.parent_id
  );
}

/**
 * Get a tuning_log entry from the database
 */
function getTuningLogEntry(
  db: Database,
  parameter: string
): {
  id: string;
  timestamp: string;
  parameter: string;
  old_value: string;
  new_value: string;
  reason: string;
  source: string;
  user_override_until: string | null;
  reverted: number;
} | null {
  const sqliteDb = db.getDb();
  const row = sqliteDb
    .prepare(
      `
    SELECT * FROM tuning_log
    WHERE parameter = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `
    )
    .get(parameter);
  return row as typeof row | null;
}

/**
 * Insert a tuning_log entry (for testing locks)
 */
function insertTuningLog(
  db: Database,
  entry: {
    parameter: string;
    old_value: number;
    new_value: number;
    reason: string;
    source: string;
    user_override_until?: string;
  }
): void {
  const sqliteDb = db.getDb();
  const stmt = sqliteDb.prepare(`
    INSERT INTO tuning_log (id, timestamp, parameter, old_value, new_value, reason, source, user_override_until, reverted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);
  stmt.run(
    randomUUID(),
    new Date().toISOString(),
    entry.parameter,
    JSON.stringify(entry.old_value),
    JSON.stringify(entry.new_value),
    entry.reason,
    entry.source,
    entry.user_override_until ?? null
  );
}

/**
 * Create a test config with custom overrides
 */
function createTestConfig(overrides: Partial<ResolvedConfig["tuning"]> = {}): ResolvedConfig {
  const base = resolveConfig({});
  return {
    ...base,
    tuning: {
      ...base.tuning,
      ...overrides,
      autoAdjust: {
        ...base.tuning.autoAdjust,
        ...(overrides.autoAdjust ?? {}),
      },
    },
  };
}

describe("TuningEngine", () => {
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    dbPath = createTempDbPath();
    db = new Database(dbPath);
  });

  afterEach(() => {
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

  describe("getTierCounts", () => {
    it("should return zero counts for empty database", () => {
      const config = createTestConfig();
      const engine = new TuningEngine(db.getDb(), config);

      const counts = engine.getTierCounts();
      expect(counts.hot).toBe(0);
      expect(counts.warm).toBe(0);
      expect(counts.cold).toBe(0);
      expect(counts.archive).toBe(0);
      expect(counts.total).toBe(0);
    });

    it("should correctly count memories by tier", () => {
      // Insert memories in different tiers
      for (let i = 0; i < 5; i++) {
        insertMemory(db, createTestMemory({ tier: Tier.HOT }));
      }
      for (let i = 0; i < 3; i++) {
        insertMemory(db, createTestMemory({ tier: Tier.WARM }));
      }
      for (let i = 0; i < 2; i++) {
        insertMemory(db, createTestMemory({ tier: Tier.COLD }));
      }

      const config = createTestConfig();
      const engine = new TuningEngine(db.getDb(), config);

      const counts = engine.getTierCounts();
      expect(counts.hot).toBe(5);
      expect(counts.warm).toBe(3);
      expect(counts.cold).toBe(2);
      expect(counts.archive).toBe(0);
      expect(counts.total).toBe(10);
    });

    it("should exclude do_not_inject memories from counts", () => {
      // Insert active memories
      for (let i = 0; i < 5; i++) {
        insertMemory(db, createTestMemory({ tier: Tier.HOT }));
      }
      // Insert do_not_inject memories (should be excluded)
      for (let i = 0; i < 3; i++) {
        insertMemory(db, createTestMemory({ tier: Tier.HOT, do_not_inject: true }));
      }

      const config = createTestConfig();
      const engine = new TuningEngine(db.getDb(), config);

      const counts = engine.getTierCounts();
      expect(counts.hot).toBe(5);
      expect(counts.total).toBe(5);
    });
  });

  describe("run - mode checks", () => {
    it("should skip adjustment when tuning is disabled", () => {
      // Insert many HOT memories to exceed target
      for (let i = 0; i < 100; i++) {
        insertMemory(db, createTestMemory({ tier: Tier.HOT }));
      }

      const config = createTestConfig({ enabled: false });
      const engine = new TuningEngine(db.getDb(), config);

      const result = engine.run();
      expect(result.adjusted).toBe(false);
      expect(result.adjustments).toHaveLength(0);

      // No tuning_log entry should exist
      const logEntry = getTuningLogEntry(db, "importanceThreshold");
      expect(logEntry).toBeFalsy();
    });

    it("should skip adjustment when mode is manual", () => {
      // Insert many HOT memories to exceed target
      for (let i = 0; i < 100; i++) {
        insertMemory(db, createTestMemory({ tier: Tier.HOT }));
      }

      const config = createTestConfig({ mode: "manual" });
      const engine = new TuningEngine(db.getDb(), config);

      const result = engine.run();
      expect(result.adjusted).toBe(false);
      expect(result.adjustments).toHaveLength(0);
    });

    it("should adjust when mode is auto", () => {
      // Insert many HOT memories to exceed target (default max is 50)
      for (let i = 0; i < 60; i++) {
        insertMemory(db, createTestMemory({ tier: Tier.HOT }));
      }

      const config = createTestConfig({ mode: "auto" });
      const engine = new TuningEngine(db.getDb(), config);

      const result = engine.run();
      expect(result.adjusted).toBe(true);
      expect(result.adjustments).toHaveLength(1);
      expect(result.adjustments[0].parameter).toBe("importanceThreshold");
    });

    it("should adjust when mode is hybrid", () => {
      // Insert many HOT memories to exceed target
      for (let i = 0; i < 60; i++) {
        insertMemory(db, createTestMemory({ tier: Tier.HOT }));
      }

      const config = createTestConfig({ mode: "hybrid" });
      const engine = new TuningEngine(db.getDb(), config);

      const result = engine.run();
      expect(result.adjusted).toBe(true);
      expect(result.adjustments).toHaveLength(1);
    });
  });

  describe("run - threshold adjustments", () => {
    it("should increase threshold when HOT tier exceeds max target", () => {
      // Insert 60 HOT memories (default max is 50)
      for (let i = 0; i < 60; i++) {
        insertMemory(db, createTestMemory({ tier: Tier.HOT }));
      }

      const config = createTestConfig({
        autoAdjust: {
          importanceThreshold: { min: 0.1, max: 0.9, step: 0.05 },
          hotTargetSize: { min: 10, max: 50 },
          warmTargetSize: { min: 50, max: 200 },
        },
      });
      const engine = new TuningEngine(db.getDb(), config);

      const initialThreshold = engine.getCurrentImportanceThreshold();
      const result = engine.run();

      expect(result.adjusted).toBe(true);
      expect(result.adjustments[0].oldValue).toBe(initialThreshold);
      expect(result.adjustments[0].newValue).toBe(initialThreshold + 0.05);
      expect(result.adjustments[0].reason).toContain("HOT tier exceeded target");
      expect(result.adjustments[0].reason).toContain("60 > 50");
    });

    it("should decrease threshold when HOT tier is below min target", () => {
      // Insert only 5 HOT memories (default min is 10)
      for (let i = 0; i < 5; i++) {
        insertMemory(db, createTestMemory({ tier: Tier.HOT }));
      }

      const config = createTestConfig({
        autoAdjust: {
          importanceThreshold: { min: 0.1, max: 0.9, step: 0.05 },
          hotTargetSize: { min: 10, max: 50 },
          warmTargetSize: { min: 50, max: 200 },
        },
      });
      const engine = new TuningEngine(db.getDb(), config);

      const initialThreshold = engine.getCurrentImportanceThreshold();
      const result = engine.run();

      expect(result.adjusted).toBe(true);
      expect(result.adjustments[0].oldValue).toBe(initialThreshold);
      expect(result.adjustments[0].newValue).toBe(initialThreshold - 0.05);
      expect(result.adjustments[0].reason).toContain("HOT tier below target");
      expect(result.adjustments[0].reason).toContain("5 < 10");
    });

    it("should not adjust when HOT tier is within target range", () => {
      // Insert 25 HOT memories (between min 10 and max 50)
      for (let i = 0; i < 25; i++) {
        insertMemory(db, createTestMemory({ tier: Tier.HOT }));
      }

      const config = createTestConfig({
        autoAdjust: {
          importanceThreshold: { min: 0.1, max: 0.9, step: 0.05 },
          hotTargetSize: { min: 10, max: 50 },
          warmTargetSize: { min: 50, max: 200 },
        },
      });
      const engine = new TuningEngine(db.getDb(), config);

      const result = engine.run();
      expect(result.adjusted).toBe(false);
      expect(result.adjustments).toHaveLength(0);
    });
  });

  describe("run - bounds enforcement", () => {
    it("should not exceed max bound when increasing threshold", () => {
      // Insert many HOT memories to exceed target
      for (let i = 0; i < 100; i++) {
        insertMemory(db, createTestMemory({ tier: Tier.HOT }));
      }

      // Set current threshold close to max via tuning_log
      insertTuningLog(db, {
        parameter: "importanceThreshold",
        old_value: 0.8,
        new_value: 0.88,
        reason: "test",
        source: "auto",
      });

      const config = createTestConfig({
        autoAdjust: {
          importanceThreshold: { min: 0.1, max: 0.9, step: 0.05 },
          hotTargetSize: { min: 10, max: 50 },
          warmTargetSize: { min: 50, max: 200 },
        },
      });
      const engine = new TuningEngine(db.getDb(), config);

      const result = engine.run();
      expect(result.adjusted).toBe(true);
      // Should cap at 0.9 (max), not 0.88 + 0.05 = 0.93
      expect(result.adjustments[0].newValue).toBe(0.9);
    });

    it("should not go below min bound when decreasing threshold", () => {
      // Insert very few HOT memories
      insertMemory(db, createTestMemory({ tier: Tier.HOT }));

      // Set current threshold close to min via tuning_log
      insertTuningLog(db, {
        parameter: "importanceThreshold",
        old_value: 0.15,
        new_value: 0.12,
        reason: "test",
        source: "auto",
      });

      const config = createTestConfig({
        autoAdjust: {
          importanceThreshold: { min: 0.1, max: 0.9, step: 0.05 },
          hotTargetSize: { min: 10, max: 50 },
          warmTargetSize: { min: 50, max: 200 },
        },
      });
      const engine = new TuningEngine(db.getDb(), config);

      const result = engine.run();
      expect(result.adjusted).toBe(true);
      // Should cap at 0.1 (min), not 0.12 - 0.05 = 0.07
      expect(result.adjustments[0].newValue).toBe(0.1);
    });
  });

  describe("run - parameter locking", () => {
    it("should skip adjustment when parameter is locked", () => {
      // Insert many HOT memories to exceed target
      for (let i = 0; i < 60; i++) {
        insertMemory(db, createTestMemory({ tier: Tier.HOT }));
      }

      // Lock the parameter until 1 day in the future
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 1);

      insertTuningLog(db, {
        parameter: "importanceThreshold",
        old_value: 0.2,
        new_value: 0.3,
        reason: "user lock",
        source: "user",
        user_override_until: futureDate.toISOString(),
      });

      const config = createTestConfig();
      const engine = new TuningEngine(db.getDb(), config);

      const result = engine.run();
      expect(result.adjusted).toBe(false);
      expect(result.adjustments).toHaveLength(0);
    });

    it("should adjust when parameter lock has expired", () => {
      // Insert many HOT memories to exceed target
      for (let i = 0; i < 60; i++) {
        insertMemory(db, createTestMemory({ tier: Tier.HOT }));
      }

      // Lock expired 1 day ago
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      insertTuningLog(db, {
        parameter: "importanceThreshold",
        old_value: 0.2,
        new_value: 0.3,
        reason: "user lock",
        source: "user",
        user_override_until: pastDate.toISOString(),
      });

      const config = createTestConfig();
      const engine = new TuningEngine(db.getDb(), config);

      const result = engine.run();
      expect(result.adjusted).toBe(true);
      expect(result.adjustments).toHaveLength(1);
    });
  });

  describe("run - tuning_log entries", () => {
    it("should create tuning_log entry when adjustment is made", () => {
      // Insert many HOT memories to exceed target
      for (let i = 0; i < 60; i++) {
        insertMemory(db, createTestMemory({ tier: Tier.HOT }));
      }

      const config = createTestConfig();
      const engine = new TuningEngine(db.getDb(), config);

      engine.run();

      const logEntry = getTuningLogEntry(db, "importanceThreshold");
      expect(logEntry).not.toBeNull();
      expect(logEntry!.parameter).toBe("importanceThreshold");
      expect(logEntry!.source).toBe("auto");
      expect(logEntry!.reason).toContain("HOT tier exceeded target");
      expect(logEntry!.reverted).toBe(0);
      expect(logEntry!.user_override_until).toBeNull();
    });
  });

  describe("getCurrentImportanceThreshold", () => {
    it("should return injection.minScore when no tuning has occurred", () => {
      const config = createTestConfig();
      config.injection.minScore = 0.25;
      const engine = new TuningEngine(db.getDb(), config);

      expect(engine.getCurrentImportanceThreshold()).toBe(0.25);
    });

    it("should return the most recent tuned value", () => {
      insertTuningLog(db, {
        parameter: "importanceThreshold",
        old_value: 0.2,
        new_value: 0.35,
        reason: "test",
        source: "auto",
      });

      const config = createTestConfig();
      const engine = new TuningEngine(db.getDb(), config);

      expect(engine.getCurrentImportanceThreshold()).toBe(0.35);
    });

    it("should ignore reverted entries", () => {
      // Insert a reverted entry
      const sqliteDb = db.getDb();
      sqliteDb
        .prepare(
          `
        INSERT INTO tuning_log (id, timestamp, parameter, old_value, new_value, reason, source, user_override_until, reverted)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)
      `
        )
        .run(
          randomUUID(),
          new Date().toISOString(),
          "importanceThreshold",
          JSON.stringify(0.2),
          JSON.stringify(0.5),
          "test",
          "auto"
        );

      const config = createTestConfig();
      config.injection.minScore = 0.2;
      const engine = new TuningEngine(db.getDb(), config);

      // Should return default since the entry is reverted
      expect(engine.getCurrentImportanceThreshold()).toBe(0.2);
    });
  });
});
