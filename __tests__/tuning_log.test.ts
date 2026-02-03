/**
 * Unit tests for tuning_log table
 *
 * Tests that:
 *   - tuning_log table is created with all required columns
 *   - source column only accepts 'auto', 'agent', 'user'
 *   - user_override_until is nullable
 *   - Indexes exist on timestamp and parameter
 *   - Migration is idempotent (safe to run twice)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Database } from "../db/sqlite.js";
import type { TuningLog, TuningSource } from "../core/types.js";

/**
 * Create a temporary database file path
 */
function createTempDbPath(): string {
  const tempDir = os.tmpdir();
  return path.join(tempDir, `test-tuning-log-${randomUUID()}.db`);
}

/**
 * Insert a tuning log entry into the database
 */
function insertTuningLog(db: Database, log: TuningLog): void {
  const sqliteDb = db.getDb();
  const insertStmt = sqliteDb.prepare(`
    INSERT INTO tuning_log (id, timestamp, parameter, old_value, new_value, reason, source, user_override_until, reverted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertStmt.run(
    log.id,
    log.timestamp,
    log.parameter,
    log.old_value,
    log.new_value,
    log.reason,
    log.source,
    log.user_override_until,
    log.reverted ? 1 : 0
  );
}

/**
 * Get tuning log entries by parameter
 */
function getTuningLogByParameter(db: Database, parameter: string): TuningLog[] {
  const sqliteDb = db.getDb();
  const rows = sqliteDb.prepare(`SELECT * FROM tuning_log WHERE parameter = ?`).all(parameter) as Array<{
    id: string;
    timestamp: string;
    parameter: string;
    old_value: string;
    new_value: string;
    reason: string;
    source: string;
    user_override_until: string | null;
    reverted: number;
  }>;

  return rows.map(row => ({
    id: row.id,
    timestamp: row.timestamp,
    parameter: row.parameter,
    old_value: row.old_value,
    new_value: row.new_value,
    reason: row.reason,
    source: row.source as TuningSource,
    user_override_until: row.user_override_until,
    reverted: row.reverted === 1,
  }));
}

/**
 * Get all tuning log entries
 */
function getAllTuningLogs(db: Database): TuningLog[] {
  const sqliteDb = db.getDb();
  const rows = sqliteDb.prepare(`SELECT * FROM tuning_log ORDER BY timestamp DESC`).all() as Array<{
    id: string;
    timestamp: string;
    parameter: string;
    old_value: string;
    new_value: string;
    reason: string;
    source: string;
    user_override_until: string | null;
    reverted: number;
  }>;

  return rows.map(row => ({
    id: row.id,
    timestamp: row.timestamp,
    parameter: row.parameter,
    old_value: row.old_value,
    new_value: row.new_value,
    reason: row.reason,
    source: row.source as TuningSource,
    user_override_until: row.user_override_until,
    reverted: row.reverted === 1,
  }));
}

describe("tuning_log table", () => {
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

  describe("table creation", () => {
    it("should create tuning_log table with all required columns", () => {
      const sqliteDb = db.getDb();

      // Check table exists
      const tableInfo = sqliteDb.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='tuning_log'
      `).get();
      expect(tableInfo).toBeDefined();

      // Check all columns exist
      const columns = sqliteDb.prepare(`PRAGMA table_info(tuning_log)`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;

      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain("id");
      expect(columnNames).toContain("timestamp");
      expect(columnNames).toContain("parameter");
      expect(columnNames).toContain("old_value");
      expect(columnNames).toContain("new_value");
      expect(columnNames).toContain("reason");
      expect(columnNames).toContain("source");
      expect(columnNames).toContain("user_override_until");
      expect(columnNames).toContain("reverted");
    });

    it("should be idempotent (safe to run twice)", () => {
      // First database creation already happened in beforeEach
      // Close and recreate to test idempotency
      db.close();

      // Creating a new Database with the same path should not throw
      expect(() => {
        db = new Database(dbPath);
      }).not.toThrow();

      // Table should still work correctly
      const sqliteDb = db.getDb();
      const tableInfo = sqliteDb.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='tuning_log'
      `).get();
      expect(tableInfo).toBeDefined();
    });
  });

  describe("indexes", () => {
    it("should have index on timestamp", () => {
      const sqliteDb = db.getDb();
      const indexes = sqliteDb.prepare(`
        SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tuning_log'
      `).all() as Array<{ name: string }>;

      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain("idx_tuning_log_timestamp");
    });

    it("should have index on parameter", () => {
      const sqliteDb = db.getDb();
      const indexes = sqliteDb.prepare(`
        SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tuning_log'
      `).all() as Array<{ name: string }>;

      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain("idx_tuning_log_parameter");
    });
  });

  describe("source column constraints", () => {
    it("should accept 'auto' as source", () => {
      const now = new Date().toISOString();
      const log: TuningLog = {
        id: randomUUID(),
        timestamp: now,
        parameter: "importanceThreshold",
        old_value: "0.3",
        new_value: "0.35",
        reason: "HOT tier exceeded target (45 > 30)",
        source: "auto",
        user_override_until: null,
        reverted: false,
      };

      expect(() => insertTuningLog(db, log)).not.toThrow();
    });

    it("should accept 'agent' as source", () => {
      const now = new Date().toISOString();
      const log: TuningLog = {
        id: randomUUID(),
        timestamp: now,
        parameter: "importanceThreshold",
        old_value: "0.35",
        new_value: "0.4",
        reason: "Agent recommended increase based on analysis",
        source: "agent",
        user_override_until: null,
        reverted: false,
      };

      expect(() => insertTuningLog(db, log)).not.toThrow();
    });

    it("should accept 'user' as source", () => {
      const now = new Date().toISOString();
      const log: TuningLog = {
        id: randomUUID(),
        timestamp: now,
        parameter: "hotTargetSize",
        old_value: "30",
        new_value: "40",
        reason: "User manual override",
        source: "user",
        user_override_until: null,
        reverted: false,
      };

      expect(() => insertTuningLog(db, log)).not.toThrow();
    });

    it("should reject invalid source values", () => {
      const sqliteDb = db.getDb();
      const now = new Date().toISOString();

      // Try to insert with invalid source
      const insertStmt = sqliteDb.prepare(`
        INSERT INTO tuning_log (id, timestamp, parameter, old_value, new_value, reason, source, user_override_until, reverted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      expect(() => {
        insertStmt.run(
          randomUUID(),
          now,
          "importanceThreshold",
          "0.3",
          "0.35",
          "Test reason",
          "invalid_source", // Invalid source
          null,
          0
        );
      }).toThrow();
    });
  });

  describe("user_override_until column", () => {
    it("should allow null value (not locked)", () => {
      const now = new Date().toISOString();
      const log: TuningLog = {
        id: randomUUID(),
        timestamp: now,
        parameter: "importanceThreshold",
        old_value: "0.3",
        new_value: "0.35",
        reason: "Auto-adjustment",
        source: "auto",
        user_override_until: null,
        reverted: false,
      };

      insertTuningLog(db, log);

      const logs = getTuningLogByParameter(db, "importanceThreshold");
      expect(logs.length).toBe(1);
      expect(logs[0].user_override_until).toBeNull();
    });

    it("should allow timestamp value (locked until date)", () => {
      const now = new Date().toISOString();
      const lockUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days from now
      const log: TuningLog = {
        id: randomUUID(),
        timestamp: now,
        parameter: "importanceThreshold",
        old_value: "0.3",
        new_value: "0.35",
        reason: "User locked parameter",
        source: "user",
        user_override_until: lockUntil,
        reverted: false,
      };

      insertTuningLog(db, log);

      const logs = getTuningLogByParameter(db, "importanceThreshold");
      expect(logs.length).toBe(1);
      expect(logs[0].user_override_until).toBe(lockUntil);
    });
  });

  describe("data operations", () => {
    it("should insert and retrieve tuning log entries", () => {
      const now = new Date().toISOString();
      const log: TuningLog = {
        id: randomUUID(),
        timestamp: now,
        parameter: "hotTargetSize",
        old_value: "30",
        new_value: "35",
        reason: "HOT tier below minimum (25 < 30)",
        source: "auto",
        user_override_until: null,
        reverted: false,
      };

      insertTuningLog(db, log);

      const logs = getTuningLogByParameter(db, "hotTargetSize");
      expect(logs.length).toBe(1);

      const retrieved = logs[0];
      expect(retrieved.id).toBe(log.id);
      expect(retrieved.timestamp).toBe(log.timestamp);
      expect(retrieved.parameter).toBe(log.parameter);
      expect(retrieved.old_value).toBe("30");
      expect(retrieved.new_value).toBe("35");
      expect(retrieved.reason).toBe("HOT tier below minimum (25 < 30)");
      expect(retrieved.source).toBe("auto");
      expect(retrieved.user_override_until).toBeNull();
      expect(retrieved.reverted).toBe(false);
    });

    it("should support multiple log entries for same parameter", () => {
      const now = new Date().toISOString();

      // Create multiple entries for the same parameter
      for (let i = 0; i < 3; i++) {
        const log: TuningLog = {
          id: randomUUID(),
          timestamp: now,
          parameter: "importanceThreshold",
          old_value: String(0.3 + i * 0.05),
          new_value: String(0.3 + (i + 1) * 0.05),
          reason: `Adjustment ${i + 1}`,
          source: "auto",
          user_override_until: null,
          reverted: false,
        };
        insertTuningLog(db, log);
      }

      const logs = getTuningLogByParameter(db, "importanceThreshold");
      expect(logs.length).toBe(3);
    });

    it("should track reverted status", () => {
      const now = new Date().toISOString();
      const log: TuningLog = {
        id: randomUUID(),
        timestamp: now,
        parameter: "warmTargetSize",
        old_value: "100",
        new_value: "120",
        reason: "Test change",
        source: "auto",
        user_override_until: null,
        reverted: true,
      };

      insertTuningLog(db, log);

      const logs = getTuningLogByParameter(db, "warmTargetSize");
      expect(logs.length).toBe(1);
      expect(logs[0].reverted).toBe(true);
    });

    it("should store JSON values in old_value and new_value", () => {
      const now = new Date().toISOString();
      const log: TuningLog = {
        id: randomUUID(),
        timestamp: now,
        parameter: "scoring.weights",
        old_value: JSON.stringify({ similarity: 0.4, importance: 0.3, recency: 0.3 }),
        new_value: JSON.stringify({ similarity: 0.5, importance: 0.25, recency: 0.25 }),
        reason: "Adjusted similarity weight",
        source: "agent",
        user_override_until: null,
        reverted: false,
      };

      insertTuningLog(db, log);

      const logs = getTuningLogByParameter(db, "scoring.weights");
      expect(logs.length).toBe(1);

      const oldValue = JSON.parse(logs[0].old_value);
      const newValue = JSON.parse(logs[0].new_value);

      expect(oldValue.similarity).toBe(0.4);
      expect(newValue.similarity).toBe(0.5);
    });
  });
});
