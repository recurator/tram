/**
 * Unit tests for injection_feedback table
 *
 * Tests that:
 *   - injection_feedback table is created with all required columns
 *   - Foreign key to memories(id) with ON DELETE CASCADE works
 *   - Index on memory_id exists
 *   - Index on injected_at exists
 *   - Migration is idempotent (safe to run twice)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Database } from "../db/sqlite.js";
import { Tier, MemoryType, type Memory, type InjectionFeedback } from "../core/types.js";

/**
 * Create a temporary database file path
 */
function createTempDbPath(): string {
  const tempDir = os.tmpdir();
  return path.join(tempDir, `test-injection-feedback-${randomUUID()}.db`);
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
 * Insert an injection feedback entry into the database
 */
function insertInjectionFeedback(db: Database, feedback: InjectionFeedback): void {
  const sqliteDb = db.getDb();
  const insertStmt = sqliteDb.prepare(`
    INSERT INTO injection_feedback (id, memory_id, session_key, injected_at, access_frequency, session_outcome, injection_density, decay_resistance, proxy_score, agent_score, agent_notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertStmt.run(
    feedback.id,
    feedback.memory_id,
    feedback.session_key,
    feedback.injected_at,
    feedback.access_frequency,
    feedback.session_outcome,
    feedback.injection_density,
    feedback.decay_resistance,
    feedback.proxy_score,
    feedback.agent_score,
    feedback.agent_notes,
    feedback.created_at
  );
}

/**
 * Get injection feedback entries by memory_id
 */
function getInjectionFeedbackByMemoryId(db: Database, memoryId: string): InjectionFeedback[] {
  const sqliteDb = db.getDb();
  const rows = sqliteDb.prepare(`SELECT * FROM injection_feedback WHERE memory_id = ?`).all(memoryId) as Array<{
    id: string;
    memory_id: string;
    session_key: string;
    injected_at: string;
    access_frequency: number;
    session_outcome: string | null;
    injection_density: number;
    decay_resistance: number | null;
    proxy_score: number | null;
    agent_score: number | null;
    agent_notes: string | null;
    created_at: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    memory_id: row.memory_id,
    session_key: row.session_key,
    injected_at: row.injected_at,
    access_frequency: row.access_frequency,
    session_outcome: row.session_outcome,
    injection_density: row.injection_density,
    decay_resistance: row.decay_resistance,
    proxy_score: row.proxy_score,
    agent_score: row.agent_score,
    agent_notes: row.agent_notes,
    created_at: row.created_at,
  }));
}

describe("injection_feedback table", () => {
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
    it("should create injection_feedback table with all required columns", () => {
      const sqliteDb = db.getDb();

      // Check table exists
      const tableInfo = sqliteDb.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='injection_feedback'
      `).get();
      expect(tableInfo).toBeDefined();

      // Check all columns exist
      const columns = sqliteDb.prepare(`PRAGMA table_info(injection_feedback)`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;

      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain("id");
      expect(columnNames).toContain("memory_id");
      expect(columnNames).toContain("session_key");
      expect(columnNames).toContain("injected_at");
      expect(columnNames).toContain("access_frequency");
      expect(columnNames).toContain("session_outcome");
      expect(columnNames).toContain("injection_density");
      expect(columnNames).toContain("decay_resistance");
      expect(columnNames).toContain("proxy_score");
      expect(columnNames).toContain("agent_score");
      expect(columnNames).toContain("agent_notes");
      expect(columnNames).toContain("created_at");
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
        SELECT name FROM sqlite_master WHERE type='table' AND name='injection_feedback'
      `).get();
      expect(tableInfo).toBeDefined();
    });
  });

  describe("indexes", () => {
    it("should have index on memory_id", () => {
      const sqliteDb = db.getDb();
      const indexes = sqliteDb.prepare(`
        SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='injection_feedback'
      `).all() as Array<{ name: string }>;

      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain("idx_injection_feedback_memory_id");
    });

    it("should have index on injected_at", () => {
      const sqliteDb = db.getDb();
      const indexes = sqliteDb.prepare(`
        SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='injection_feedback'
      `).all() as Array<{ name: string }>;

      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain("idx_injection_feedback_injected_at");
    });
  });

  describe("foreign key cascade", () => {
    it("should delete injection_feedback rows when memory is deleted", () => {
      const sqliteDb = db.getDb();

      // Enable foreign keys (SQLite requires explicit enable)
      sqliteDb.pragma("foreign_keys = ON");

      // Create a memory
      const memory = createTestMemory();
      insertMemory(db, memory);

      // Create injection feedback for the memory
      const now = new Date().toISOString();
      const feedback: InjectionFeedback = {
        id: randomUUID(),
        memory_id: memory.id,
        session_key: "test-session-123",
        injected_at: now,
        access_frequency: 0,
        session_outcome: null,
        injection_density: 0.25,
        decay_resistance: null,
        proxy_score: null,
        agent_score: null,
        agent_notes: null,
        created_at: now,
      };
      insertInjectionFeedback(db, feedback);

      // Verify feedback exists
      let feedbackRows = getInjectionFeedbackByMemoryId(db, memory.id);
      expect(feedbackRows.length).toBe(1);

      // Delete the memory
      sqliteDb.prepare(`DELETE FROM memories WHERE id = ?`).run(memory.id);

      // Verify feedback was also deleted (CASCADE)
      feedbackRows = getInjectionFeedbackByMemoryId(db, memory.id);
      expect(feedbackRows.length).toBe(0);
    });
  });

  describe("data operations", () => {
    it("should insert and retrieve injection feedback", () => {
      // Create a memory
      const memory = createTestMemory();
      insertMemory(db, memory);

      // Create injection feedback
      const now = new Date().toISOString();
      const feedback: InjectionFeedback = {
        id: randomUUID(),
        memory_id: memory.id,
        session_key: "test-session-456",
        injected_at: now,
        access_frequency: 3,
        session_outcome: "success",
        injection_density: 0.5,
        decay_resistance: 0.8,
        proxy_score: 0.7,
        agent_score: 0.9,
        agent_notes: "Very helpful memory",
        created_at: now,
      };
      insertInjectionFeedback(db, feedback);

      // Retrieve and verify
      const feedbackRows = getInjectionFeedbackByMemoryId(db, memory.id);
      expect(feedbackRows.length).toBe(1);

      const retrieved = feedbackRows[0];
      expect(retrieved.id).toBe(feedback.id);
      expect(retrieved.memory_id).toBe(feedback.memory_id);
      expect(retrieved.session_key).toBe(feedback.session_key);
      expect(retrieved.access_frequency).toBe(3);
      expect(retrieved.session_outcome).toBe("success");
      expect(retrieved.injection_density).toBe(0.5);
      expect(retrieved.decay_resistance).toBe(0.8);
      expect(retrieved.proxy_score).toBe(0.7);
      expect(retrieved.agent_score).toBe(0.9);
      expect(retrieved.agent_notes).toBe("Very helpful memory");
    });

    it("should support multiple feedback entries for same memory", () => {
      // Create a memory
      const memory = createTestMemory();
      insertMemory(db, memory);

      // Create multiple injection feedback entries
      const now = new Date().toISOString();
      for (let i = 0; i < 3; i++) {
        const feedback: InjectionFeedback = {
          id: randomUUID(),
          memory_id: memory.id,
          session_key: `session-${i}`,
          injected_at: now,
          access_frequency: i,
          session_outcome: null,
          injection_density: 0.25,
          decay_resistance: null,
          proxy_score: null,
          agent_score: null,
          agent_notes: null,
          created_at: now,
        };
        insertInjectionFeedback(db, feedback);
      }

      // Verify all feedback entries exist
      const feedbackRows = getInjectionFeedbackByMemoryId(db, memory.id);
      expect(feedbackRows.length).toBe(3);
    });

    it("should allow null values for optional columns", () => {
      // Create a memory
      const memory = createTestMemory();
      insertMemory(db, memory);

      // Create injection feedback with minimal data (nulls for optional)
      const now = new Date().toISOString();
      const feedback: InjectionFeedback = {
        id: randomUUID(),
        memory_id: memory.id,
        session_key: "test-session",
        injected_at: now,
        access_frequency: 0,
        session_outcome: null,
        injection_density: 0.1,
        decay_resistance: null,
        proxy_score: null,
        agent_score: null,
        agent_notes: null,
        created_at: now,
      };
      insertInjectionFeedback(db, feedback);

      // Verify it was stored correctly
      const feedbackRows = getInjectionFeedbackByMemoryId(db, memory.id);
      expect(feedbackRows.length).toBe(1);
      expect(feedbackRows[0].session_outcome).toBeNull();
      expect(feedbackRows[0].decay_resistance).toBeNull();
      expect(feedbackRows[0].proxy_score).toBeNull();
      expect(feedbackRows[0].agent_score).toBeNull();
      expect(feedbackRows[0].agent_notes).toBeNull();
    });
  });
});
