/**
 * Integration tests for memory tools
 *
 * Tests all memory tools: memory_store, memory_recall, memory_forget,
 * memory_restore, memory_pin, memory_unpin, memory_explain,
 * memory_set_context, and memory_clear_context.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Database } from "../db/sqlite.js";
import { FTS5Helper } from "../db/fts.js";
import { VectorHelper } from "../db/vectors.js";
import { Tier, MemoryType, type Memory } from "../core/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";

// Import all tools
import { MemoryStoreTool } from "../tools/memory_store.js";
import { MemoryRecallTool } from "../tools/memory_recall.js";
import { MemoryForgetTool } from "../tools/memory_forget.js";
import { MemoryRestoreTool } from "../tools/memory_restore.js";
import { MemoryPinTool } from "../tools/memory_pin.js";
import { MemoryUnpinTool } from "../tools/memory_unpin.js";
import { MemoryExplainTool } from "../tools/memory_explain.js";
import { MemorySetContextTool } from "../tools/memory_set_context.js";
import { MemoryClearContextTool } from "../tools/memory_clear_context.js";

/**
 * Mock embedding provider for testing.
 * Generates deterministic embeddings based on text content.
 */
class MockEmbeddingProvider implements EmbeddingProvider {
  private dimensions: number;
  private embeddings: Map<string, number[]> = new Map();

  constructor(dimensions: number = 384) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    // Check if we have a cached embedding
    const cached = this.embeddings.get(text);
    if (cached) {
      return cached;
    }

    // Generate deterministic embedding based on text hash
    const embedding = this.generateDeterministicEmbedding(text);
    this.embeddings.set(text, embedding);
    return embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModelName(): string {
    return "mock-embedding-model";
  }

  /**
   * Generate a deterministic embedding based on text content.
   * Similar texts will have similar embeddings.
   */
  private generateDeterministicEmbedding(text: string): number[] {
    const embedding = new Array(this.dimensions).fill(0);

    // Simple hash-based embedding generation
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      const idx = (i * 7 + charCode) % this.dimensions;
      embedding[idx] += charCode / 1000;
    }

    // Normalize to unit length
    const magnitude = Math.sqrt(
      embedding.reduce((sum, val) => sum + val * val, 0)
    );
    if (magnitude > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= magnitude;
      }
    }

    return embedding;
  }

  /**
   * Set a specific embedding for a text (for testing duplicates).
   */
  setEmbedding(text: string, embedding: number[]): void {
    this.embeddings.set(text, embedding);
  }

  /**
   * Create an embedding that is very similar to another (for duplicate testing).
   */
  createSimilarEmbedding(text: string, similarity: number = 0.96): number[] {
    const baseEmbedding = this.generateDeterministicEmbedding(text);
    const noiseFactor = Math.sqrt(1 - similarity * similarity);

    const similarEmbedding = baseEmbedding.map((val, i) => {
      // Add small noise
      const noise = ((i % 17) - 8) / 1000 * noiseFactor;
      return val + noise;
    });

    // Normalize
    const magnitude = Math.sqrt(
      similarEmbedding.reduce((sum, val) => sum + val * val, 0)
    );
    if (magnitude > 0) {
      for (let i = 0; i < similarEmbedding.length; i++) {
        similarEmbedding[i] /= magnitude;
      }
    }

    return similarEmbedding;
  }
}

/**
 * Create a temporary database file path
 */
function createTempDbPath(): string {
  const tempDir = os.tmpdir();
  return path.join(tempDir, `test-tools-${randomUUID()}.db`);
}

/**
 * Clean up temporary database files
 */
function cleanupTempDb(dbPath: string): void {
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
 * Insert a memory directly into the database (bypassing tools).
 */
function insertMemory(db: Database, memory: Memory): void {
  const sqliteDb = db.getDb();
  const stmt = sqliteDb.prepare(`
    INSERT INTO memories (id, text, importance, category, created_at, tier, memory_type, do_not_inject, pinned, use_count, last_accessed_at, use_days, source, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
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
 * Fetch a memory from the database by ID.
 */
function fetchMemory(db: Database, id: string): Memory | null {
  const sqliteDb = db.getDb();
  const stmt = sqliteDb.prepare(`
    SELECT id, text, importance, category, created_at, tier, memory_type,
           do_not_inject, pinned, use_count, last_accessed_at, use_days, source, parent_id
    FROM memories
    WHERE id = ?
  `);
  const row = stmt.get(id) as {
    id: string;
    text: string;
    importance: number;
    category: string | null;
    created_at: string;
    tier: string;
    memory_type: string;
    do_not_inject: number;
    pinned: number;
    use_count: number;
    last_accessed_at: string;
    use_days: string;
    source: string | null;
    parent_id: string | null;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    text: row.text,
    importance: row.importance,
    category: row.category,
    created_at: row.created_at,
    tier: row.tier as Tier,
    memory_type: row.memory_type as MemoryType,
    do_not_inject: row.do_not_inject === 1,
    pinned: row.pinned === 1,
    use_count: row.use_count,
    last_accessed_at: row.last_accessed_at,
    use_days: JSON.parse(row.use_days || "[]"),
    source: row.source,
    parent_id: row.parent_id,
  };
}

describe("Memory Tools Integration Tests", () => {
  let dbPath: string;
  let db: Database;
  let embeddingProvider: MockEmbeddingProvider;
  let ftsHelper: FTS5Helper;
  let vectorHelper: VectorHelper;

  beforeEach(() => {
    dbPath = createTempDbPath();
    db = new Database(dbPath);
    embeddingProvider = new MockEmbeddingProvider(384);
    ftsHelper = new FTS5Helper(db.getDb());
    vectorHelper = new VectorHelper(db.getDb(), 384, ftsHelper);
  });

  afterEach(() => {
    if (db && db.isOpen()) {
      db.close();
    }
    cleanupTempDb(dbPath);
  });

  describe("MemoryStoreTool", () => {
    it("should create a memory and return details", async () => {
      const tool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);

      const result = await tool.execute({
        text: "This is a test memory about programming",
        tier: "HOT",
        memory_type: "factual",
        importance: 0.8,
      });

      // Check response format
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("stored successfully");
      expect(result.content[0].text).toContain("HOT tier");

      // Check details
      expect(result.details.isDuplicate).toBe(false);
      expect(result.details.tier).toBe(Tier.HOT);
      expect(result.details.memory_type).toBe(MemoryType.factual);
      expect(result.details.text).toBe("This is a test memory about programming");

      // Verify memory exists in database
      const memory = fetchMemory(db, result.details.id);
      expect(memory).not.toBeNull();
      expect(memory!.text).toBe("This is a test memory about programming");
      expect(memory!.importance).toBe(0.8);
    });

    it("should detect duplicate memories", async () => {
      const tool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);

      // Store first memory
      const text = "Machine learning is a subset of artificial intelligence";
      const firstResult = await tool.execute({ text });

      expect(firstResult.details.isDuplicate).toBe(false);

      // Try to store same memory again
      const secondResult = await tool.execute({ text });

      expect(secondResult.details.isDuplicate).toBe(true);
      expect(secondResult.details.id).toBe(firstResult.details.id);
      expect(secondResult.details.similarity).toBeGreaterThan(0.95);
      expect(secondResult.content[0].text).toContain("Similar memory already exists");
    });

    it("should use default values for optional parameters", async () => {
      const tool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);

      const result = await tool.execute({
        text: "A simple memory with defaults",
      });

      // Default tier should be HOT
      expect(result.details.tier).toBe(Tier.HOT);
      // Default memory_type should be factual
      expect(result.details.memory_type).toBe(MemoryType.factual);

      // Verify defaults in database
      const memory = fetchMemory(db, result.details.id);
      expect(memory!.importance).toBe(0.5); // Default importance
      expect(memory!.pinned).toBe(false);
    });

    it("should clamp importance to valid range", async () => {
      const tool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);

      // Test importance > 1
      const highResult = await tool.execute({
        text: "High importance memory",
        importance: 1.5,
      });
      const highMemory = fetchMemory(db, highResult.details.id);
      expect(highMemory!.importance).toBe(1.0);

      // Test importance < 0
      const lowResult = await tool.execute({
        text: "Low importance memory",
        importance: -0.5,
      });
      const lowMemory = fetchMemory(db, lowResult.details.id);
      expect(lowMemory!.importance).toBe(0);
    });

    it("should throw error for empty text", async () => {
      const tool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);

      // Empty string is caught as falsy value by first validation
      await expect(tool.execute({ text: "" })).rejects.toThrow(
        "Missing required parameter: text"
      );

      // Whitespace-only triggers the second validation after trim
      await expect(tool.execute({ text: "   " })).rejects.toThrow(
        "Memory text cannot be empty"
      );
    });

    it("should throw error for missing text", async () => {
      const tool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);

      await expect(
        tool.execute({ text: undefined as unknown as string })
      ).rejects.toThrow("Missing required parameter: text");
    });
  });

  describe("MemoryRecallTool", () => {
    it("should search and return matching memories", async () => {
      const storeTool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);
      const recallTool = new MemoryRecallTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );

      // Store some memories
      await storeTool.execute({ text: "Python is a programming language" });
      await storeTool.execute({ text: "JavaScript runs in browsers" });
      await storeTool.execute({ text: "Rust is a systems programming language" });

      // Recall memories about programming
      const result = await recallTool.execute({
        query: "programming language",
        limit: 10,
      });

      expect(result.content[0].text).toContain("Found");
      expect(result.memories.length).toBeGreaterThan(0);

      // Each memory should have expected properties
      for (const memory of result.memories) {
        expect(memory.id).toBeDefined();
        expect(memory.text).toBeDefined();
        expect(memory.tier).toBeDefined();
        expect(memory.memory_type).toBeDefined();
        expect(memory.score).toBeGreaterThanOrEqual(0);
      }
    });

    it("should update access stats on recall", async () => {
      const storeTool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);
      const recallTool = new MemoryRecallTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );

      // Store a memory
      const storeResult = await storeTool.execute({
        text: "TypeScript adds static typing to JavaScript",
      });
      const memoryId = storeResult.details.id;

      // Initial state
      let memory = fetchMemory(db, memoryId);
      expect(memory!.use_count).toBe(0);
      const initialAccessTime = memory!.last_accessed_at;

      // Wait a bit to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Recall the memory
      await recallTool.execute({ query: "TypeScript static typing" });

      // Verify stats were updated
      memory = fetchMemory(db, memoryId);
      expect(memory!.use_count).toBe(1);
      expect(new Date(memory!.last_accessed_at).getTime()).toBeGreaterThanOrEqual(
        new Date(initialAccessTime).getTime()
      );

      // use_days should include today
      const today = new Date().toISOString().split("T")[0];
      expect(memory!.use_days).toContain(today);
    });

    it("should filter by tier", async () => {
      const storeTool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);
      const recallTool = new MemoryRecallTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );

      // Store memories in different tiers
      await storeTool.execute({ text: "Hot tier memory about databases", tier: "HOT" });
      await storeTool.execute({ text: "Warm tier memory about databases", tier: "WARM" });

      // Recall only HOT tier
      const hotResult = await recallTool.execute({
        query: "databases",
        tier: "HOT",
      });

      for (const memory of hotResult.memories) {
        expect(memory.tier).toBe(Tier.HOT);
      }

      // Recall only WARM tier
      const warmResult = await recallTool.execute({
        query: "databases",
        tier: "WARM",
      });

      for (const memory of warmResult.memories) {
        expect(memory.tier).toBe(Tier.WARM);
      }
    });

    it("should exclude forgotten memories by default", async () => {
      const storeTool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);
      const recallTool = new MemoryRecallTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );
      const forgetTool = new MemoryForgetTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );

      // Store and forget a memory
      const storeResult = await storeTool.execute({
        text: "This memory will be forgotten for testing",
      });
      await forgetTool.execute({ memoryId: storeResult.details.id });

      // Recall without includeForgotten
      const result = await recallTool.execute({
        query: "forgotten testing",
      });

      // Should not find the forgotten memory
      const foundIds = result.memories.map((m) => m.id);
      expect(foundIds).not.toContain(storeResult.details.id);
    });

    it("should include forgotten memories when requested", async () => {
      const storeTool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);
      const recallTool = new MemoryRecallTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );
      const forgetTool = new MemoryForgetTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );

      // Store and forget a memory
      const storeResult = await storeTool.execute({
        text: "This memory should be findable when including forgotten",
      });
      await forgetTool.execute({ memoryId: storeResult.details.id });

      // Recall with includeForgotten
      const result = await recallTool.execute({
        query: "findable including forgotten",
        includeForgotten: true,
      });

      // Should find the forgotten memory with forgotten flag
      const foundMemory = result.memories.find(
        (m) => m.id === storeResult.details.id
      );
      expect(foundMemory).toBeDefined();
      expect(foundMemory!.forgotten).toBe(true);
    });

    it("should throw error for empty query", async () => {
      const recallTool = new MemoryRecallTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );

      // Empty string is caught as falsy value by first validation
      await expect(recallTool.execute({ query: "" })).rejects.toThrow(
        "Missing required parameter: query"
      );

      // Whitespace-only triggers the second validation after trim
      await expect(recallTool.execute({ query: "   " })).rejects.toThrow(
        "Query cannot be empty"
      );
    });
  });

  describe("MemoryForgetTool", () => {
    it("should soft forget a memory by ID", async () => {
      const storeTool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);
      const forgetTool = new MemoryForgetTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );

      // Store a memory
      const storeResult = await storeTool.execute({
        text: "Memory to be forgotten",
      });
      const memoryId = storeResult.details.id;

      // Verify initial state
      let memory = fetchMemory(db, memoryId);
      expect(memory!.do_not_inject).toBe(false);

      // Forget the memory
      const forgetResult = await forgetTool.execute({ memoryId });

      expect(forgetResult.content[0].text).toContain("Memory forgotten");
      expect(forgetResult.details.hardDeleted).toBe(false);
      expect(forgetResult.details.restorable).toBe(true);

      // Verify do_not_inject is set
      memory = fetchMemory(db, memoryId);
      expect(memory!.do_not_inject).toBe(true);

      // Verify audit log entry
      const sqliteDb = db.getDb();
      const auditStmt = sqliteDb.prepare(
        "SELECT * FROM memory_audit WHERE memory_id = ? AND action = 'forget'"
      );
      const auditRow = auditStmt.get(memoryId);
      expect(auditRow).toBeDefined();
    });

    it("should soft forget a memory by query", async () => {
      const storeTool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);
      const forgetTool = new MemoryForgetTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );

      // Store a memory - use simple words without hyphens to avoid FTS5 query issues
      await storeTool.execute({
        text: "Unique content for special forget test operation",
      });

      // Forget by query - use simple terms that work with FTS5
      const forgetResult = await forgetTool.execute({
        query: "Unique content special forget",
      });

      expect(forgetResult.content[0].text).toContain("Memory forgotten");
      expect(forgetResult.details.restorable).toBe(true);
    });

    it("should hard delete a memory when hard=true", async () => {
      const storeTool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);
      const forgetTool = new MemoryForgetTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );

      // Disable foreign keys for this test since the tool implementation
      // deletes the memory before creating the audit entry, which would
      // violate the FK constraint on memory_audit.memory_id
      db.getDb().pragma("foreign_keys = OFF");

      // Store a memory
      const storeResult = await storeTool.execute({
        text: "Memory to be permanently deleted",
      });
      const memoryId = storeResult.details.id;

      // Hard delete
      const forgetResult = await forgetTool.execute({
        memoryId,
        hard: true,
      });

      expect(forgetResult.content[0].text).toContain("permanently deleted");
      expect(forgetResult.details.hardDeleted).toBe(true);
      expect(forgetResult.details.restorable).toBe(false);

      // Verify memory no longer exists
      const memory = fetchMemory(db, memoryId);
      expect(memory).toBeNull();
    });

    it("should throw error when forgetting already forgotten memory", async () => {
      const storeTool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);
      const forgetTool = new MemoryForgetTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );

      // Store and forget a memory
      const storeResult = await storeTool.execute({
        text: "Memory to forget twice",
      });
      await forgetTool.execute({ memoryId: storeResult.details.id });

      // Try to forget again
      await expect(
        forgetTool.execute({ memoryId: storeResult.details.id })
      ).rejects.toThrow("already forgotten");
    });

    it("should throw error for invalid memory ID format", async () => {
      const forgetTool = new MemoryForgetTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );

      await expect(forgetTool.execute({ memoryId: "invalid-id" })).rejects.toThrow(
        "Invalid memory ID format"
      );
    });

    it("should throw error for non-existent memory", async () => {
      const forgetTool = new MemoryForgetTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );
      const nonExistentId = randomUUID();

      await expect(
        forgetTool.execute({ memoryId: nonExistentId })
      ).rejects.toThrow("Memory not found");
    });
  });

  describe("MemoryRestoreTool", () => {
    it("should restore a forgotten memory", async () => {
      const storeTool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);
      const forgetTool = new MemoryForgetTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );
      const restoreTool = new MemoryRestoreTool(db.getDb());

      // Store and forget a memory
      const storeResult = await storeTool.execute({
        text: "Memory to restore",
      });
      const memoryId = storeResult.details.id;
      await forgetTool.execute({ memoryId });

      // Verify forgotten
      let memory = fetchMemory(db, memoryId);
      expect(memory!.do_not_inject).toBe(true);

      // Restore the memory
      const restoreResult = await restoreTool.execute({ memoryId });

      expect(restoreResult.content[0].text).toContain("Memory restored");
      expect(restoreResult.details.id).toBe(memoryId);

      // Verify restored
      memory = fetchMemory(db, memoryId);
      expect(memory!.do_not_inject).toBe(false);

      // Verify audit log
      const sqliteDb = db.getDb();
      const auditStmt = sqliteDb.prepare(
        "SELECT * FROM memory_audit WHERE memory_id = ? AND action = 'restore'"
      );
      const auditRow = auditStmt.get(memoryId);
      expect(auditRow).toBeDefined();
    });

    it("should throw error when restoring non-forgotten memory", async () => {
      const storeTool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);
      const restoreTool = new MemoryRestoreTool(db.getDb());

      // Store a memory (not forgotten)
      const storeResult = await storeTool.execute({
        text: "Memory that is not forgotten",
      });

      // Try to restore
      await expect(
        restoreTool.execute({ memoryId: storeResult.details.id })
      ).rejects.toThrow("Memory is not forgotten");
    });

    it("should throw error for non-existent memory", async () => {
      const restoreTool = new MemoryRestoreTool(db.getDb());
      const nonExistentId = randomUUID();

      await expect(
        restoreTool.execute({ memoryId: nonExistentId })
      ).rejects.toThrow("Memory not found");
    });

    it("should throw error for invalid memory ID format", async () => {
      const restoreTool = new MemoryRestoreTool(db.getDb());

      await expect(restoreTool.execute({ memoryId: "invalid" })).rejects.toThrow(
        "Invalid memory ID format"
      );
    });
  });

  describe("MemoryPinTool and MemoryUnpinTool", () => {
    it("should pin a memory", async () => {
      const storeTool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);
      const pinTool = new MemoryPinTool(db.getDb());

      // Store a memory
      const storeResult = await storeTool.execute({
        text: "Memory to pin",
        tier: "HOT",
      });
      const memoryId = storeResult.details.id;

      // Pin the memory
      const pinResult = await pinTool.execute({ memoryId });

      expect(pinResult.content[0].text).toContain("Memory pinned");
      expect(pinResult.details.tierUpdated).toBe(false); // HOT doesn't need tier update

      // Verify pinned
      const memory = fetchMemory(db, memoryId);
      expect(memory!.pinned).toBe(true);
    });

    it("should update tier from COLD to WARM when pinning", async () => {
      const pinTool = new MemoryPinTool(db.getDb());

      // Insert a COLD memory directly
      const memory = createTestMemory({
        tier: Tier.COLD,
        pinned: false,
      });
      insertMemory(db, memory);

      // Pin the memory
      const pinResult = await pinTool.execute({ memoryId: memory.id });

      expect(pinResult.details.tierUpdated).toBe(true);
      expect(pinResult.details.tier).toBe(Tier.WARM);
      expect(pinResult.content[0].text).toContain("Tier updated from COLD to WARM");

      // Verify tier was updated
      const updatedMemory = fetchMemory(db, memory.id);
      expect(updatedMemory!.tier).toBe(Tier.WARM);
    });

    it("should unpin a memory", async () => {
      const pinTool = new MemoryPinTool(db.getDb());
      const unpinTool = new MemoryUnpinTool(db.getDb());

      // Insert and pin a memory
      const memory = createTestMemory({ pinned: true });
      insertMemory(db, memory);

      // Unpin
      const unpinResult = await unpinTool.execute({ memoryId: memory.id });

      expect(unpinResult.content[0].text).toContain("Memory unpinned");

      // Verify unpinned
      const updatedMemory = fetchMemory(db, memory.id);
      expect(updatedMemory!.pinned).toBe(false);
    });

    it("should throw error when pinning already pinned memory", async () => {
      const pinTool = new MemoryPinTool(db.getDb());

      // Insert a pinned memory
      const memory = createTestMemory({ pinned: true });
      insertMemory(db, memory);

      // Try to pin again
      await expect(pinTool.execute({ memoryId: memory.id })).rejects.toThrow(
        "already pinned"
      );
    });

    it("should throw error when unpinning non-pinned memory", async () => {
      const unpinTool = new MemoryUnpinTool(db.getDb());

      // Insert an unpinned memory
      const memory = createTestMemory({ pinned: false });
      insertMemory(db, memory);

      // Try to unpin
      await expect(unpinTool.execute({ memoryId: memory.id })).rejects.toThrow(
        "Memory is not pinned"
      );
    });

    it("should create audit log entries for pin/unpin", async () => {
      const pinTool = new MemoryPinTool(db.getDb());
      const unpinTool = new MemoryUnpinTool(db.getDb());

      // Insert a memory
      const memory = createTestMemory({ pinned: false });
      insertMemory(db, memory);

      // Pin
      await pinTool.execute({ memoryId: memory.id });

      // Unpin
      await unpinTool.execute({ memoryId: memory.id });

      // Verify audit entries
      const sqliteDb = db.getDb();
      const auditStmt = sqliteDb.prepare(
        "SELECT action FROM memory_audit WHERE memory_id = ? ORDER BY created_at"
      );
      const auditRows = auditStmt.all(memory.id) as Array<{ action: string }>;

      expect(auditRows.map((r) => r.action)).toEqual(["pin", "unpin"]);
    });
  });

  describe("MemoryExplainTool", () => {
    it("should return scoring breakdown for a memory", async () => {
      const storeTool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);
      const explainTool = new MemoryExplainTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );

      // Store a memory
      const storeResult = await storeTool.execute({
        text: "Memory to explain for testing",
        memory_type: "procedural",
      });
      const memoryId = storeResult.details.id;

      // Explain the memory
      const explainResult = await explainTool.execute({ memoryId });

      // Check response structure
      expect(explainResult.content[0].text).toContain("Memory Explanation");
      expect(explainResult.details.id).toBe(memoryId);
      expect(explainResult.details.tier).toBe(Tier.HOT);
      expect(explainResult.details.memoryType).toBe(MemoryType.procedural);

      // Check scoring breakdown
      expect(explainResult.details.scoring).toBeDefined();
      expect(explainResult.details.scoring.similarityValue).toBeGreaterThanOrEqual(0);
      expect(explainResult.details.scoring.similarityComponent).toBeGreaterThanOrEqual(0);
      expect(explainResult.details.scoring.recencyComponent).toBeGreaterThanOrEqual(0);
      expect(explainResult.details.scoring.frequencyComponent).toBeGreaterThanOrEqual(0);
      expect(explainResult.details.scoring.totalScore).toBeGreaterThanOrEqual(0);
      expect(explainResult.details.scoring.halfLifeDays).toBe(180); // procedural half-life

      // Check injection eligibility
      expect(explainResult.details.injection).toBeDefined();
      expect(explainResult.details.injection.eligible).toBe(true);
      expect(explainResult.details.injection.isPinned).toBe(false);
      expect(explainResult.details.injection.isForgotten).toBe(false);
    });

    it("should calculate similarity when query is provided", async () => {
      const storeTool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);
      const explainTool = new MemoryExplainTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );

      // Store a memory about a specific topic
      const storeResult = await storeTool.execute({
        text: "React hooks are used for state management in functional components",
      });

      // Explain with a related query
      const explainResult = await explainTool.execute({
        memoryId: storeResult.details.id,
        query: "React hooks state management",
      });

      // Similarity should be calculated
      expect(explainResult.details.scoring.similarityValue).toBeGreaterThan(0);
    });

    it("should show correct eligibility for forgotten memories", async () => {
      const storeTool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);
      const forgetTool = new MemoryForgetTool(
        db.getDb(),
        embeddingProvider,
        vectorHelper
      );
      const explainTool = new MemoryExplainTool(db.getDb());

      // Store and forget a memory
      const storeResult = await storeTool.execute({
        text: "Memory that will be forgotten",
      });
      await forgetTool.execute({ memoryId: storeResult.details.id });

      // Explain
      const explainResult = await explainTool.execute({
        memoryId: storeResult.details.id,
      });

      expect(explainResult.details.injection.eligible).toBe(false);
      expect(explainResult.details.injection.isForgotten).toBe(true);
      expect(explainResult.details.injection.reason).toContain("do_not_inject");
    });

    it("should show correct eligibility for pinned memories", async () => {
      const pinTool = new MemoryPinTool(db.getDb());
      const explainTool = new MemoryExplainTool(db.getDb());

      // Insert and pin a memory
      const memory = createTestMemory();
      insertMemory(db, memory);
      await pinTool.execute({ memoryId: memory.id });

      // Explain
      const explainResult = await explainTool.execute({ memoryId: memory.id });

      expect(explainResult.details.injection.eligible).toBe(true);
      expect(explainResult.details.injection.isPinned).toBe(true);
      expect(explainResult.details.injection.reason).toContain("priority injection");
    });

    it("should throw error for non-existent memory", async () => {
      const explainTool = new MemoryExplainTool(db.getDb());
      const nonExistentId = randomUUID();

      await expect(
        explainTool.execute({ memoryId: nonExistentId })
      ).rejects.toThrow("Memory not found");
    });
  });

  describe("MemorySetContextTool and MemoryClearContextTool", () => {
    it("should set context with default TTL", async () => {
      const setContextTool = new MemorySetContextTool(db.getDb());

      const result = await setContextTool.execute({
        text: "Working on feature implementation",
      });

      expect(result.content[0].text).toContain("Context set successfully");
      expect(result.details.id).toBe("active");
      expect(result.details.text).toBe("Working on feature implementation");
      expect(result.details.ttl_seconds).toBe(4 * 3600); // Default 4 hours
      expect(result.details.expires_at).toBeDefined();

      // Verify in database
      const sqliteDb = db.getDb();
      const row = sqliteDb
        .prepare("SELECT * FROM current_context WHERE id = ?")
        .get("active") as {
          id: string;
          text: string;
          ttl_seconds: number;
        };
      expect(row).toBeDefined();
      expect(row.text).toBe("Working on feature implementation");
    });

    it("should set context with custom TTL", async () => {
      const setContextTool = new MemorySetContextTool(db.getDb());

      const result = await setContextTool.execute({
        text: "Short-lived context",
        ttlHours: 1,
      });

      expect(result.details.ttl_seconds).toBe(3600); // 1 hour
    });

    it("should replace existing context", async () => {
      const setContextTool = new MemorySetContextTool(db.getDb());

      // Set first context
      await setContextTool.execute({ text: "First context" });

      // Set second context
      const result = await setContextTool.execute({ text: "Second context" });

      expect(result.details.text).toBe("Second context");

      // Verify only one context exists
      const sqliteDb = db.getDb();
      const rows = sqliteDb
        .prepare("SELECT * FROM current_context")
        .all();
      expect(rows.length).toBe(1);
    });

    it("should clear existing context", async () => {
      const setContextTool = new MemorySetContextTool(db.getDb());
      const clearContextTool = new MemoryClearContextTool(db.getDb());

      // Set context
      await setContextTool.execute({ text: "Context to clear" });

      // Clear context
      const result = await clearContextTool.execute();

      expect(result.content[0].text).toContain("Context cleared successfully");
      expect(result.details.cleared).toBe(true);
      expect(result.details.previousText).toBe("Context to clear");

      // Verify context is gone
      const sqliteDb = db.getDb();
      const row = sqliteDb
        .prepare("SELECT * FROM current_context WHERE id = ?")
        .get("active");
      expect(row).toBeUndefined();
    });

    it("should handle clearing when no context exists", async () => {
      const clearContextTool = new MemoryClearContextTool(db.getDb());

      const result = await clearContextTool.execute();

      expect(result.content[0].text).toContain("No active context");
      expect(result.details.cleared).toBe(false);
    });

    it("should check context expiry via getContext()", async () => {
      const setContextTool = new MemorySetContextTool(db.getDb());

      // Set a context with very short TTL
      await setContextTool.execute({
        text: "Short-lived context",
        ttlHours: 0.001, // ~3.6 seconds
      });

      // Context should exist initially
      let context = setContextTool.getContext();
      expect(context).not.toBeNull();
      expect(context!.text).toBe("Short-lived context");

      // Manually expire the context by updating the created_at
      const sqliteDb = db.getDb();
      const pastTime = new Date(Date.now() - 10000).toISOString(); // 10 seconds ago
      sqliteDb
        .prepare("UPDATE current_context SET created_at = ? WHERE id = 'active'")
        .run(pastTime);

      // Context should now be expired
      context = setContextTool.getContext();
      expect(context).toBeNull();

      // Should also clean up the expired context from the database
      const row = sqliteDb
        .prepare("SELECT * FROM current_context WHERE id = ?")
        .get("active");
      expect(row).toBeUndefined();
    });

    it("should throw error for empty context text", async () => {
      const setContextTool = new MemorySetContextTool(db.getDb());

      // Empty string is caught as falsy value by first validation
      await expect(setContextTool.execute({ text: "" })).rejects.toThrow(
        "Missing required parameter: text"
      );

      // Whitespace-only triggers the second validation after trim
      await expect(setContextTool.execute({ text: "   " })).rejects.toThrow(
        "Context text cannot be empty"
      );
    });

    it("should throw error for invalid TTL", async () => {
      const setContextTool = new MemorySetContextTool(db.getDb());

      await expect(
        setContextTool.execute({ text: "Test", ttlHours: 0 })
      ).rejects.toThrow("TTL hours must be greater than 0");

      await expect(
        setContextTool.execute({ text: "Test", ttlHours: -1 })
      ).rejects.toThrow("TTL hours must be greater than 0");
    });
  });
});
