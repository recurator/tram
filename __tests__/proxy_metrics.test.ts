/**
 * Unit tests for US-013: Track proxy metrics post-injection
 *
 * Tests that:
 *   - After auto-recall completes, injection_feedback is recorded for each injected memory
 *   - injection_density = injected_count / total_candidates
 *   - session_key from current session context
 *   - Metrics recorded asynchronously (don't block injection)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Database } from "../db/sqlite.js";
import { Tier, MemoryType, type Memory, type InjectionFeedback } from "../core/types.js";
import {
  handler,
  initAutoRecallHook,
  type BeforeAgentStartEvent,
  type AgentContext,
} from "../hooks/auto-recall/handler.js";
import { VectorHelper } from "../db/vectors.js";
import { resolveConfig, type ResolvedConfig } from "../config.js";

/**
 * Create a temporary database file path
 */
function createTempDbPath(): string {
  const tempDir = os.tmpdir();
  return path.join(tempDir, `test-proxy-metrics-${randomUUID()}.db`);
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
 * Get all injection feedback entries from the database
 */
function getAllInjectionFeedback(db: Database): InjectionFeedback[] {
  const sqliteDb = db.getDb();
  const rows = sqliteDb.prepare(`SELECT * FROM injection_feedback ORDER BY created_at`).all() as Array<{
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
 * Insert a vector for a memory
 */
function insertVector(db: Database, memoryId: string, embedding: number[]): void {
  const sqliteDb = db.getDb();

  // Ensure memory_vectors table exists
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS memory_vectors (
      memory_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    )
  `);

  const insertStmt = sqliteDb.prepare(`
    INSERT INTO memory_vectors (memory_id, embedding)
    VALUES (?, ?)
  `);

  // Convert embedding to buffer
  const buffer = Buffer.from(new Float32Array(embedding).buffer);
  insertStmt.run(memoryId, buffer);
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

/**
 * Create default config for testing
 */
function createTestConfig(): ResolvedConfig {
  return resolveConfig({});
}

/**
 * Wait for setImmediate callbacks to complete
 */
function flushSetImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("US-013: Track proxy metrics post-injection", () => {
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

  describe("injection_feedback recording", () => {
    it("should record injection_feedback for each injected memory after auto-recall", async () => {
      // Create test memories
      const memory1 = createTestMemory({ id: randomUUID(), text: "Test memory about authentication" });
      const memory2 = createTestMemory({ id: randomUUID(), text: "Test memory about database queries" });

      insertMemory(db, memory1);
      insertMemory(db, memory2);

      // Create mock dependencies
      const mockEmbeddingProvider = createMockEmbeddingProvider();
      const mockVectorHelper = createMockVectorHelper([memory1, memory2]);
      const config = createTestConfig();

      // Initialize the hook
      initAutoRecallHook(db.getDb(), mockEmbeddingProvider as any, mockVectorHelper as any, config);

      // Create event and context
      const event: BeforeAgentStartEvent = {
        prompt: "How do I authenticate with the database?",
      };

      const ctx: AgentContext = {
        sessionKey: "test-session-123",
        session: { type: "main" },
      };

      // Execute the handler
      const result = await handler(event, ctx);

      // Wait for async metrics recording (uses setImmediate)
      await flushSetImmediate();

      // Verify injection_feedback was recorded
      const feedbackEntries = getAllInjectionFeedback(db);

      expect(feedbackEntries.length).toBe(2);

      // Verify each injected memory has a feedback entry
      const memoryIds = feedbackEntries.map(f => f.memory_id);
      expect(memoryIds).toContain(memory1.id);
      expect(memoryIds).toContain(memory2.id);

      // Verify session_key is recorded correctly
      for (const entry of feedbackEntries) {
        expect(entry.session_key).toBe("test-session-123");
        expect(entry.access_frequency).toBe(0);
      }
    });

    it("should calculate injection_density = injected_count / total_candidates", async () => {
      // Create 10 test memories (only 5 will be injected due to maxItems)
      // Note: Using 10 memories with maxItems=5 to ensure budget allocation works
      // (budgets with small maxItems can result in 0 slots due to Math.floor)
      const memories = [];
      for (let i = 0; i < 10; i++) {
        memories.push(createTestMemory({ id: randomUUID(), text: `Memory ${i + 1}` }));
      }

      for (const memory of memories) {
        insertMemory(db, memory);
      }

      // Create mock dependencies - all 10 memories are candidates
      const mockEmbeddingProvider = createMockEmbeddingProvider();
      const mockVectorHelper = createMockVectorHelper(memories);

      // Config with maxItems=5 to inject only 5 of 10 candidates
      // With default budgets: pinned=1, hot=2, warm=1, cold=0 = 4 slots
      // But all memories are HOT tier, so only hot slots (2) will be used
      // Let's use custom budgets to make it simpler: 100% hot
      const config = resolveConfig({
        injection: {
          maxItems: 5,
          budgets: { pinned: 0, hot: 100, warm: 0, cold: 0 },
        },
      });

      // Initialize the hook
      initAutoRecallHook(db.getDb(), mockEmbeddingProvider as any, mockVectorHelper as any, config);

      // Create event and context
      const event: BeforeAgentStartEvent = {
        prompt: "Test query for memories",
      };

      const ctx: AgentContext = {
        sessionKey: "density-test-session",
        session: { type: "main" },
      };

      // Execute the handler
      await handler(event, ctx);

      // Wait for async metrics recording
      await flushSetImmediate();

      // Verify injection_feedback was recorded
      const feedbackEntries = getAllInjectionFeedback(db);

      // Should have 5 entries (maxItems=5, all HOT tier with 100% hot budget)
      expect(feedbackEntries.length).toBe(5);

      // injection_density should be 5/10 = 0.5
      for (const entry of feedbackEntries) {
        expect(entry.injection_density).toBe(0.5);
      }
    });

    it("should use session_key from context", async () => {
      const memory = createTestMemory({ id: randomUUID(), text: "Session key test memory" });
      insertMemory(db, memory);

      const mockEmbeddingProvider = createMockEmbeddingProvider();
      const mockVectorHelper = createMockVectorHelper([memory]);
      const config = createTestConfig();

      initAutoRecallHook(db.getDb(), mockEmbeddingProvider as any, mockVectorHelper as any, config);

      const event: BeforeAgentStartEvent = {
        prompt: "Test query",
      };

      // Use a unique session key
      const uniqueSessionKey = `unique-session-${randomUUID()}`;
      const ctx: AgentContext = {
        sessionKey: uniqueSessionKey,
        session: { type: "main" },
      };

      await handler(event, ctx);
      await flushSetImmediate();

      const feedbackEntries = getAllInjectionFeedback(db);

      expect(feedbackEntries.length).toBe(1);
      expect(feedbackEntries[0].session_key).toBe(uniqueSessionKey);
    });

    it("should use 'unknown' when sessionKey is not provided", async () => {
      const memory = createTestMemory({ id: randomUUID(), text: "No session key test" });
      insertMemory(db, memory);

      const mockEmbeddingProvider = createMockEmbeddingProvider();
      const mockVectorHelper = createMockVectorHelper([memory]);
      const config = createTestConfig();

      initAutoRecallHook(db.getDb(), mockEmbeddingProvider as any, mockVectorHelper as any, config);

      const event: BeforeAgentStartEvent = {
        prompt: "Test query",
      };

      // Context without sessionKey
      const ctx: AgentContext = {
        session: { type: "main" },
      };

      await handler(event, ctx);
      await flushSetImmediate();

      const feedbackEntries = getAllInjectionFeedback(db);

      expect(feedbackEntries.length).toBe(1);
      expect(feedbackEntries[0].session_key).toBe("unknown");
    });

    it("should not block injection (metrics recorded asynchronously)", async () => {
      const memory = createTestMemory({ id: randomUUID(), text: "Async test memory" });
      insertMemory(db, memory);

      const mockEmbeddingProvider = createMockEmbeddingProvider();
      const mockVectorHelper = createMockVectorHelper([memory]);
      const config = createTestConfig();

      initAutoRecallHook(db.getDb(), mockEmbeddingProvider as any, mockVectorHelper as any, config);

      const event: BeforeAgentStartEvent = {
        prompt: "Test async recording",
      };

      const ctx: AgentContext = {
        sessionKey: "async-test",
        session: { type: "main" },
      };

      // Execute and check result immediately (before setImmediate runs)
      const result = await handler(event, ctx);

      // Injection should complete immediately with memories
      expect(result).toBeDefined();
      expect(result?.prependContext).toBeDefined();

      // At this point, metrics may not be recorded yet (async)
      // Verify they ARE recorded after flushing
      await flushSetImmediate();

      const feedbackEntries = getAllInjectionFeedback(db);
      expect(feedbackEntries.length).toBe(1);
    });

    it("should record injected_at timestamp", async () => {
      const memory = createTestMemory({ id: randomUUID(), text: "Timestamp test memory" });
      insertMemory(db, memory);

      const mockEmbeddingProvider = createMockEmbeddingProvider();
      const mockVectorHelper = createMockVectorHelper([memory]);
      const config = createTestConfig();

      initAutoRecallHook(db.getDb(), mockEmbeddingProvider as any, mockVectorHelper as any, config);

      const beforeTime = new Date();

      const event: BeforeAgentStartEvent = {
        prompt: "Test query for timestamp",
      };

      const ctx: AgentContext = {
        sessionKey: "timestamp-test",
        session: { type: "main" },
      };

      await handler(event, ctx);
      await flushSetImmediate();

      const afterTime = new Date();

      const feedbackEntries = getAllInjectionFeedback(db);

      expect(feedbackEntries.length).toBe(1);

      const injectedAt = new Date(feedbackEntries[0].injected_at);
      expect(injectedAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(injectedAt.getTime()).toBeLessThanOrEqual(afterTime.getTime());
    });

    it("should set access_frequency to 0 initially", async () => {
      const memory = createTestMemory({ id: randomUUID(), text: "Access frequency test" });
      insertMemory(db, memory);

      const mockEmbeddingProvider = createMockEmbeddingProvider();
      const mockVectorHelper = createMockVectorHelper([memory]);
      const config = createTestConfig();

      initAutoRecallHook(db.getDb(), mockEmbeddingProvider as any, mockVectorHelper as any, config);

      const event: BeforeAgentStartEvent = {
        prompt: "Test query",
      };

      const ctx: AgentContext = {
        sessionKey: "access-freq-test",
        session: { type: "main" },
      };

      await handler(event, ctx);
      await flushSetImmediate();

      const feedbackEntries = getAllInjectionFeedback(db);

      expect(feedbackEntries.length).toBe(1);
      expect(feedbackEntries[0].access_frequency).toBe(0);
    });
  });

  describe("no injection scenarios", () => {
    it("should not record feedback when no memories are injected", async () => {
      // No memories in database - empty results
      const mockEmbeddingProvider = createMockEmbeddingProvider();
      const mockVectorHelper = createMockVectorHelper([]);
      const config = createTestConfig();

      initAutoRecallHook(db.getDb(), mockEmbeddingProvider as any, mockVectorHelper as any, config);

      const event: BeforeAgentStartEvent = {
        prompt: "Test query",
      };

      const ctx: AgentContext = {
        sessionKey: "no-results-test",
        session: { type: "main" },
      };

      await handler(event, ctx);
      await flushSetImmediate();

      const feedbackEntries = getAllInjectionFeedback(db);
      expect(feedbackEntries.length).toBe(0);
    });

    it("should not record feedback when auto-inject is disabled for session type", async () => {
      const memory = createTestMemory({ id: randomUUID(), text: "Disabled session test" });
      insertMemory(db, memory);

      const mockEmbeddingProvider = createMockEmbeddingProvider();
      const mockVectorHelper = createMockVectorHelper([memory]);

      // Config with autoInject disabled for cron sessions
      const config = resolveConfig({
        sessions: {
          cron: { autoInject: false },
        },
      });

      initAutoRecallHook(db.getDb(), mockEmbeddingProvider as any, mockVectorHelper as any, config);

      const event: BeforeAgentStartEvent = {
        prompt: "Test query",
      };

      // Use cron session type
      const ctx: AgentContext = {
        sessionKey: "cron-session",
        session: { type: "cron" },
      };

      await handler(event, ctx);
      await flushSetImmediate();

      const feedbackEntries = getAllInjectionFeedback(db);
      expect(feedbackEntries.length).toBe(0);
    });
  });
});
