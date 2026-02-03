/**
 * Unit tests for US-014: Update access metrics on memory recall
 *
 * Tests that:
 *   - When memory_recall tool returns a memory, increment its feedback access_frequency
 *   - Find feedback row by memory_id + most recent injected_at
 *   - If no feedback row exists, skip (memory wasn't auto-injected)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Database } from "../db/sqlite.js";
import { Tier, MemoryType, type Memory, type InjectionFeedback } from "../core/types.js";
import { MemoryRecallTool, type MemoryRecallInput } from "../tools/memory_recall.js";
import { VectorHelper } from "../db/vectors.js";

/**
 * Create a temporary database file path
 */
function createTempDbPath(): string {
  const tempDir = os.tmpdir();
  return path.join(tempDir, `test-access-frequency-${randomUUID()}.db`);
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
 * Insert an injection_feedback entry
 */
function insertInjectionFeedback(
  db: Database,
  memoryId: string,
  sessionKey: string,
  injectedAt: string,
  accessFrequency: number = 0
): string {
  const id = randomUUID();
  const sqliteDb = db.getDb();
  const insertStmt = sqliteDb.prepare(`
    INSERT INTO injection_feedback (id, memory_id, session_key, injected_at, access_frequency, injection_density, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertStmt.run(
    id,
    memoryId,
    sessionKey,
    injectedAt,
    accessFrequency,
    0.5,
    new Date().toISOString()
  );
  return id;
}

/**
 * Get injection_feedback entry by id
 */
function getInjectionFeedback(db: Database, feedbackId: string): InjectionFeedback | undefined {
  const sqliteDb = db.getDb();
  const row = sqliteDb.prepare(`SELECT * FROM injection_feedback WHERE id = ?`).get(feedbackId) as {
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
  } | undefined;

  if (!row) return undefined;

  return {
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
  };
}

/**
 * Get all injection_feedback entries for a memory
 */
function getInjectionFeedbackForMemory(db: Database, memoryId: string): InjectionFeedback[] {
  const sqliteDb = db.getDb();
  const rows = sqliteDb.prepare(`
    SELECT * FROM injection_feedback WHERE memory_id = ? ORDER BY injected_at DESC
  `).all(memoryId) as Array<{
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

/**
 * Create a mock embedding provider
 */
function createMockEmbeddingProvider() {
  return {
    embed: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  };
}

/**
 * Create a mock VectorHelper that returns controlled results
 */
function createMockVectorHelper(memories: Memory[]) {
  return {
    hybridSearch: vi.fn().mockReturnValue(
      memories.map((m) => ({
        id: m.id,
        vectorScore: 0.8,
        ftsScore: 0.5,
      }))
    ),
  };
}

describe("US-014: Update access metrics on memory recall", () => {
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    dbPath = createTempDbPath();
    db = new Database(dbPath);
    vi.clearAllMocks();
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

  describe("access_frequency increment", () => {
    it("should increment access_frequency when memory_recall returns a memory with existing feedback", async () => {
      // Create test memory
      const memory = createTestMemory({ id: randomUUID(), text: "Test memory for access frequency" });
      insertMemory(db, memory);

      // Insert injection_feedback for the memory
      const feedbackId = insertInjectionFeedback(
        db,
        memory.id,
        "test-session",
        new Date().toISOString(),
        0 // initial access_frequency
      );

      // Verify initial access_frequency is 0
      let feedback = getInjectionFeedback(db, feedbackId);
      expect(feedback?.access_frequency).toBe(0);

      // Create mock dependencies
      const mockEmbeddingProvider = createMockEmbeddingProvider();
      const mockVectorHelper = createMockVectorHelper([memory]);

      // Create and execute the recall tool
      const tool = new MemoryRecallTool(
        db.getDb(),
        mockEmbeddingProvider as any,
        mockVectorHelper as any
      );

      const input: MemoryRecallInput = {
        query: "test memory access",
        limit: 5,
      };

      const result = await tool.execute(input);

      // Verify memory was recalled
      expect(result.memories.length).toBe(1);
      expect(result.memories[0].id).toBe(memory.id);

      // Verify access_frequency was incremented
      feedback = getInjectionFeedback(db, feedbackId);
      expect(feedback?.access_frequency).toBe(1);
    });

    it("should increment access_frequency multiple times on repeated recalls", async () => {
      const memory = createTestMemory({ id: randomUUID(), text: "Multiple recall test" });
      insertMemory(db, memory);

      const feedbackId = insertInjectionFeedback(
        db,
        memory.id,
        "test-session",
        new Date().toISOString(),
        0
      );

      const mockEmbeddingProvider = createMockEmbeddingProvider();
      const mockVectorHelper = createMockVectorHelper([memory]);

      const tool = new MemoryRecallTool(
        db.getDb(),
        mockEmbeddingProvider as any,
        mockVectorHelper as any
      );

      // Recall the memory 3 times
      for (let i = 0; i < 3; i++) {
        await tool.execute({ query: "test query" });
      }

      // Verify access_frequency is 3
      const feedback = getInjectionFeedback(db, feedbackId);
      expect(feedback?.access_frequency).toBe(3);
    });

    it("should find feedback by memory_id and most recent injected_at", async () => {
      const memory = createTestMemory({ id: randomUUID(), text: "Multiple feedback test" });
      insertMemory(db, memory);

      // Insert older feedback entry
      const oldTime = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
      const oldFeedbackId = insertInjectionFeedback(
        db,
        memory.id,
        "old-session",
        oldTime,
        5 // already has some accesses
      );

      // Insert newer feedback entry
      const newTime = new Date().toISOString();
      const newFeedbackId = insertInjectionFeedback(
        db,
        memory.id,
        "new-session",
        newTime,
        0 // fresh injection
      );

      const mockEmbeddingProvider = createMockEmbeddingProvider();
      const mockVectorHelper = createMockVectorHelper([memory]);

      const tool = new MemoryRecallTool(
        db.getDb(),
        mockEmbeddingProvider as any,
        mockVectorHelper as any
      );

      await tool.execute({ query: "test query" });

      // Verify only the newer feedback was incremented
      const oldFeedback = getInjectionFeedback(db, oldFeedbackId);
      const newFeedback = getInjectionFeedback(db, newFeedbackId);

      expect(oldFeedback?.access_frequency).toBe(5); // unchanged
      expect(newFeedback?.access_frequency).toBe(1); // incremented
    });
  });

  describe("skip when no feedback exists", () => {
    it("should skip access_frequency update when memory has no injection_feedback entry", async () => {
      // Create memory without any injection_feedback
      const memory = createTestMemory({ id: randomUUID(), text: "Memory without feedback" });
      insertMemory(db, memory);

      const mockEmbeddingProvider = createMockEmbeddingProvider();
      const mockVectorHelper = createMockVectorHelper([memory]);

      const tool = new MemoryRecallTool(
        db.getDb(),
        mockEmbeddingProvider as any,
        mockVectorHelper as any
      );

      // Should not throw even though no feedback exists
      const result = await tool.execute({ query: "test query" });

      // Memory should still be recalled successfully
      expect(result.memories.length).toBe(1);
      expect(result.memories[0].id).toBe(memory.id);

      // Verify no feedback entries exist
      const feedbackEntries = getInjectionFeedbackForMemory(db, memory.id);
      expect(feedbackEntries.length).toBe(0);
    });

    it("should handle mixed memories - some with feedback, some without", async () => {
      // Memory with feedback
      const memoryWithFeedback = createTestMemory({ id: randomUUID(), text: "Memory with feedback" });
      insertMemory(db, memoryWithFeedback);
      const feedbackId = insertInjectionFeedback(
        db,
        memoryWithFeedback.id,
        "test-session",
        new Date().toISOString(),
        0
      );

      // Memory without feedback
      const memoryWithoutFeedback = createTestMemory({ id: randomUUID(), text: "Memory without feedback" });
      insertMemory(db, memoryWithoutFeedback);

      const mockEmbeddingProvider = createMockEmbeddingProvider();
      const mockVectorHelper = createMockVectorHelper([memoryWithFeedback, memoryWithoutFeedback]);

      const tool = new MemoryRecallTool(
        db.getDb(),
        mockEmbeddingProvider as any,
        mockVectorHelper as any
      );

      const result = await tool.execute({ query: "test query" });

      // Both memories should be recalled
      expect(result.memories.length).toBe(2);

      // Only the memory with feedback should have access_frequency incremented
      const feedback = getInjectionFeedback(db, feedbackId);
      expect(feedback?.access_frequency).toBe(1);

      // Memory without feedback should have no feedback entries
      const noFeedbackEntries = getInjectionFeedbackForMemory(db, memoryWithoutFeedback.id);
      expect(noFeedbackEntries.length).toBe(0);
    });
  });

  describe("integration with memory access stats", () => {
    it("should update both memory use_count and feedback access_frequency", async () => {
      const memory = createTestMemory({ id: randomUUID(), text: "Full integration test" });
      insertMemory(db, memory);

      const feedbackId = insertInjectionFeedback(
        db,
        memory.id,
        "test-session",
        new Date().toISOString(),
        0
      );

      const mockEmbeddingProvider = createMockEmbeddingProvider();
      const mockVectorHelper = createMockVectorHelper([memory]);

      const tool = new MemoryRecallTool(
        db.getDb(),
        mockEmbeddingProvider as any,
        mockVectorHelper as any
      );

      // Initial state
      const initialMemoryRow = db.getDb().prepare(`SELECT use_count FROM memories WHERE id = ?`).get(memory.id) as { use_count: number };
      expect(initialMemoryRow.use_count).toBe(0);

      // Execute recall
      await tool.execute({ query: "test query" });

      // Verify memory use_count is updated
      const updatedMemoryRow = db.getDb().prepare(`SELECT use_count FROM memories WHERE id = ?`).get(memory.id) as { use_count: number };
      expect(updatedMemoryRow.use_count).toBe(1);

      // Verify feedback access_frequency is also updated
      const feedback = getInjectionFeedback(db, feedbackId);
      expect(feedback?.access_frequency).toBe(1);
    });
  });
});
