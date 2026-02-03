/**
 * Unit tests for parameter lock/unlock CLI commands
 *
 * Tests that:
 *   - tram lock <parameter> sets user_override_until in tuning_log
 *   - Locked duration uses config.tuning.lockDurationDays
 *   - tram unlock <parameter> clears the lock
 *   - TuningEngine skips locked parameters
 *   - Expired locks are ignored (auto-tuning resumes)
 *   - Invalid parameter names are rejected
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Database } from "../db/sqlite.js";
import { TuningEngine } from "../core/tuning.js";
import { MemoryLockCommand, LOCKABLE_PARAMETERS, isLockableParameter } from "../cli/lock.js";
import { Tier, MemoryType, type Memory } from "../core/types.js";
import { resolveConfig } from "../config.js";
import type { ResolvedConfig } from "../config.js";

/**
 * Create a temporary database file path
 */
function createTempDbPath(): string {
  const tempDir = os.tmpdir();
  return path.join(tempDir, `test-lock-${randomUUID()}.db`);
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
 * Get the most recent tuning_log entry for a parameter
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
    ORDER BY timestamp DESC, rowid DESC
    LIMIT 1
  `
    )
    .get(parameter);
  return row as typeof row | null;
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

describe("MemoryLockCommand", () => {
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

  describe("isLockableParameter", () => {
    it("should return true for valid parameters", () => {
      expect(isLockableParameter("importanceThreshold")).toBe(true);
    });

    it("should return false for invalid parameters", () => {
      expect(isLockableParameter("invalidParam")).toBe(false);
      expect(isLockableParameter("")).toBe(false);
      expect(isLockableParameter("random")).toBe(false);
    });
  });

  describe("lock", () => {
    it("should create tuning_log entry with user_override_until", () => {
      const config = createTestConfig({ lockDurationDays: 7 });
      const lockCommand = new MemoryLockCommand(db.getDb(), config);

      const result = lockCommand.lock("importanceThreshold", { json: true });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.parameter).toBe("importanceThreshold");
      expect(parsed.action).toBe("lock");
      expect(parsed.lockedUntil).toBeDefined();

      // Verify the lock is approximately 7 days in the future
      const lockUntil = new Date(parsed.lockedUntil);
      const expectedLock = new Date();
      expectedLock.setDate(expectedLock.getDate() + 7);
      const diffDays = Math.abs(lockUntil.getTime() - expectedLock.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeLessThan(1); // Within 1 day tolerance

      // Verify tuning_log entry
      const logEntry = getTuningLogEntry(db, "importanceThreshold");
      expect(logEntry).not.toBeNull();
      expect(logEntry!.source).toBe("user");
      expect(logEntry!.user_override_until).not.toBeNull();
      expect(logEntry!.reason).toContain("User locked parameter");
    });

    it("should use lockDurationDays from config", () => {
      const config = createTestConfig({ lockDurationDays: 14 });
      const lockCommand = new MemoryLockCommand(db.getDb(), config);

      const result = lockCommand.lock("importanceThreshold", { json: true });
      const parsed = JSON.parse(result);

      const lockUntil = new Date(parsed.lockedUntil);
      const expectedLock = new Date();
      expectedLock.setDate(expectedLock.getDate() + 14);
      const diffDays = Math.abs(lockUntil.getTime() - expectedLock.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeLessThan(1);
    });

    it("should reject invalid parameter names", () => {
      const config = createTestConfig();
      const lockCommand = new MemoryLockCommand(db.getDb(), config);

      const result = lockCommand.lock("invalidParam", { json: true });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.message).toContain("Invalid parameter");
      expect(parsed.message).toContain("importanceThreshold");
    });

    it("should format text output correctly", () => {
      const config = createTestConfig();
      const lockCommand = new MemoryLockCommand(db.getDb(), config);

      const result = lockCommand.lock("importanceThreshold", { json: false });

      expect(result).toContain("Parameter Lock: importanceThreshold");
      expect(result).toContain("✓ Parameter 'importanceThreshold' locked");
      expect(result).toContain("Locked until:");
      expect(result).toContain("tram-unlock importanceThreshold");
    });
  });

  describe("unlock", () => {
    it("should clear the lock by creating entry without user_override_until", () => {
      const config = createTestConfig();
      const lockCommand = new MemoryLockCommand(db.getDb(), config);

      // First lock the parameter
      lockCommand.lock("importanceThreshold", {});

      // Then unlock it
      const result = lockCommand.unlock("importanceThreshold", { json: true });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.parameter).toBe("importanceThreshold");
      expect(parsed.action).toBe("unlock");

      // Verify the most recent tuning_log entry has no lock
      const logEntry = getTuningLogEntry(db, "importanceThreshold");
      expect(logEntry).not.toBeNull();
      expect(logEntry!.source).toBe("user");
      expect(logEntry!.user_override_until).toBeNull();
      expect(logEntry!.reason).toBe("User unlocked parameter");
    });

    it("should fail if parameter is not locked", () => {
      const config = createTestConfig();
      const lockCommand = new MemoryLockCommand(db.getDb(), config);

      const result = lockCommand.unlock("importanceThreshold", { json: true });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.message).toContain("not currently locked");
    });

    it("should reject invalid parameter names", () => {
      const config = createTestConfig();
      const lockCommand = new MemoryLockCommand(db.getDb(), config);

      const result = lockCommand.unlock("invalidParam", { json: true });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.message).toContain("Invalid parameter");
    });

    it("should format text output correctly", () => {
      const config = createTestConfig();
      const lockCommand = new MemoryLockCommand(db.getDb(), config);

      // First lock the parameter
      lockCommand.lock("importanceThreshold", {});

      // Then unlock it
      const result = lockCommand.unlock("importanceThreshold", { json: false });

      expect(result).toContain("Parameter Unlock: importanceThreshold");
      expect(result).toContain("✓ Parameter 'importanceThreshold' unlocked");
      expect(result).toContain("Auto-tuning will now adjust");
    });
  });

  describe("TuningEngine integration", () => {
    it("should skip locked parameters during auto-tuning", () => {
      // Insert many HOT memories to exceed target (normally would trigger adjustment)
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

      // Lock the parameter
      const lockCommand = new MemoryLockCommand(db.getDb(), config);
      lockCommand.lock("importanceThreshold", {});

      // Run tuning engine
      const tuningEngine = new TuningEngine(db.getDb(), config);
      const result = tuningEngine.run();

      // Should NOT have adjusted because parameter is locked
      expect(result.adjusted).toBe(false);
      expect(result.adjustments).toHaveLength(0);
    });

    it("should allow tuning after unlock", () => {
      // Insert many HOT memories to exceed target
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

      const lockCommand = new MemoryLockCommand(db.getDb(), config);

      // Lock the parameter
      lockCommand.lock("importanceThreshold", {});

      // Verify tuning is blocked
      const tuningEngine = new TuningEngine(db.getDb(), config);
      let result = tuningEngine.run();
      expect(result.adjusted).toBe(false);

      // Unlock the parameter
      lockCommand.unlock("importanceThreshold", {});

      // Run tuning again - should adjust now
      result = tuningEngine.run();
      expect(result.adjusted).toBe(true);
      expect(result.adjustments).toHaveLength(1);
      expect(result.adjustments[0].parameter).toBe("importanceThreshold");
    });

    it("should resume tuning after lock expires", () => {
      // Insert many HOT memories to exceed target
      for (let i = 0; i < 60; i++) {
        insertMemory(db, createTestMemory({ tier: Tier.HOT }));
      }

      const config = createTestConfig();

      // Manually insert an expired lock (1 day ago)
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      const sqliteDb = db.getDb();
      sqliteDb
        .prepare(
          `
        INSERT INTO tuning_log (id, timestamp, parameter, old_value, new_value, reason, source, user_override_until, reverted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `
        )
        .run(
          randomUUID(),
          new Date().toISOString(),
          "importanceThreshold",
          JSON.stringify(0.2),
          JSON.stringify(0.2),
          "Expired lock",
          "user",
          pastDate.toISOString()
        );

      // Run tuning - should adjust since lock is expired
      const tuningEngine = new TuningEngine(db.getDb(), config);
      const result = tuningEngine.run();

      expect(result.adjusted).toBe(true);
      expect(result.adjustments).toHaveLength(1);
    });
  });

  describe("current value tracking", () => {
    it("should return current value from tuning_log when locking", () => {
      // Set a current value via tuning_log
      const sqliteDb = db.getDb();
      sqliteDb
        .prepare(
          `
        INSERT INTO tuning_log (id, timestamp, parameter, old_value, new_value, reason, source, user_override_until, reverted)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)
      `
        )
        .run(
          randomUUID(),
          new Date().toISOString(),
          "importanceThreshold",
          JSON.stringify(0.2),
          JSON.stringify(0.35),
          "Previous adjustment",
          "auto"
        );

      const config = createTestConfig();
      const lockCommand = new MemoryLockCommand(db.getDb(), config);

      const result = lockCommand.lock("importanceThreshold", { json: true });
      const parsed = JSON.parse(result);

      expect(parsed.currentValue).toBe(0.35);
    });

    it("should return default value when no tuning_log exists", () => {
      const config = createTestConfig();
      config.injection.minScore = 0.25;
      const lockCommand = new MemoryLockCommand(db.getDb(), config);

      const result = lockCommand.lock("importanceThreshold", { json: true });
      const parsed = JSON.parse(result);

      expect(parsed.currentValue).toBe(0.25);
    });
  });
});
