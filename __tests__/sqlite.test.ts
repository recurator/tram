/**
 * Unit tests for SQLite database operations
 *
 * Tests schema creation, memory CRUD operations, FTS5 sync triggers,
 * current_context operations with TTL, and audit log creation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Database } from "../db/sqlite.js";
import { FTS5Helper } from "../db/fts.js";
import { Tier, MemoryType, type Memory, type MemoryAudit } from "../core/types.js";

/**
 * Create a temporary database file path
 */
function createTempDbPath(): string {
  const tempDir = os.tmpdir();
  return path.join(tempDir, `test-memory-${randomUUID()}.db`);
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

describe("Database", () => {
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
      // Also clean up WAL and SHM files if they exist
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

  describe("schema creation", () => {
    it("should create the memories table with all required columns", () => {
      const sqliteDb = db.getDb();
      const tableInfo = sqliteDb.prepare("PRAGMA table_info(memories)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      const columnNames = tableInfo.map((col) => col.name);

      expect(columnNames).toContain("id");
      expect(columnNames).toContain("text");
      expect(columnNames).toContain("importance");
      expect(columnNames).toContain("category");
      expect(columnNames).toContain("created_at");
      expect(columnNames).toContain("tier");
      expect(columnNames).toContain("memory_type");
      expect(columnNames).toContain("do_not_inject");
      expect(columnNames).toContain("pinned");
      expect(columnNames).toContain("use_count");
      expect(columnNames).toContain("last_accessed_at");
      expect(columnNames).toContain("use_days");
      expect(columnNames).toContain("source");
      expect(columnNames).toContain("parent_id");
      expect(columnNames).toContain("entity_refs");
      expect(columnNames).toContain("meta_type");
    });

    it("should have id as primary key", () => {
      const sqliteDb = db.getDb();
      const tableInfo = sqliteDb.prepare("PRAGMA table_info(memories)").all() as Array<{
        name: string;
        pk: number;
      }>;

      const idColumn = tableInfo.find((col) => col.name === "id");
      expect(idColumn?.pk).toBe(1);
    });

    it("should have correct default values for columns", () => {
      const sqliteDb = db.getDb();
      const tableInfo = sqliteDb.prepare("PRAGMA table_info(memories)").all() as Array<{
        name: string;
        dflt_value: string | null;
      }>;

      const defaults: Record<string, string | null> = {};
      for (const col of tableInfo) {
        defaults[col.name] = col.dflt_value;
      }

      expect(defaults["importance"]).toBe("0.5");
      expect(defaults["tier"]).toBe("'HOT'");
      expect(defaults["memory_type"]).toBe("'factual'");
      expect(defaults["do_not_inject"]).toBe("0");
      expect(defaults["pinned"]).toBe("0");
      expect(defaults["use_count"]).toBe("0");
      expect(defaults["use_days"]).toBe("'[]'");
    });

    it("should enforce tier CHECK constraint", () => {
      const sqliteDb = db.getDb();
      const memory = createTestMemory();

      const insertStmt = sqliteDb.prepare(`
        INSERT INTO memories (id, text, importance, category, created_at, tier, memory_type, do_not_inject, pinned, use_count, last_accessed_at, use_days, source, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Valid tier should work
      expect(() => {
        insertStmt.run(
          memory.id,
          memory.text,
          memory.importance,
          memory.category,
          memory.created_at,
          Tier.HOT,
          memory.memory_type,
          memory.do_not_inject ? 1 : 0,
          memory.pinned ? 1 : 0,
          memory.use_count,
          memory.last_accessed_at,
          JSON.stringify(memory.use_days),
          memory.source,
          memory.parent_id
        );
      }).not.toThrow();

      // Invalid tier should throw
      const badMemory = createTestMemory();
      expect(() => {
        insertStmt.run(
          badMemory.id,
          badMemory.text,
          badMemory.importance,
          badMemory.category,
          badMemory.created_at,
          "INVALID_TIER",
          badMemory.memory_type,
          badMemory.do_not_inject ? 1 : 0,
          badMemory.pinned ? 1 : 0,
          badMemory.use_count,
          badMemory.last_accessed_at,
          JSON.stringify(badMemory.use_days),
          badMemory.source,
          badMemory.parent_id
        );
      }).toThrow();
    });

    it("should create all required indexes", () => {
      const sqliteDb = db.getDb();
      const indexes = sqliteDb.prepare("PRAGMA index_list(memories)").all() as Array<{
        name: string;
      }>;

      const indexNames = indexes.map((idx) => idx.name);

      expect(indexNames).toContain("idx_memories_tier");
      expect(indexNames).toContain("idx_memories_do_not_inject");
      expect(indexNames).toContain("idx_memories_pinned");
      expect(indexNames).toContain("idx_memories_last_accessed");
    });

    it("should create the current_context table", () => {
      const sqliteDb = db.getDb();
      const tableInfo = sqliteDb.prepare("PRAGMA table_info(current_context)").all() as Array<{
        name: string;
        type: string;
      }>;

      const columnNames = tableInfo.map((col) => col.name);

      expect(columnNames).toContain("id");
      expect(columnNames).toContain("text");
      expect(columnNames).toContain("created_at");
      expect(columnNames).toContain("ttl_seconds");
    });

    it("should create the memory_audit table", () => {
      const sqliteDb = db.getDb();
      const tableInfo = sqliteDb.prepare("PRAGMA table_info(memory_audit)").all() as Array<{
        name: string;
        type: string;
      }>;

      const columnNames = tableInfo.map((col) => col.name);

      expect(columnNames).toContain("id");
      expect(columnNames).toContain("memory_id");
      expect(columnNames).toContain("action");
      expect(columnNames).toContain("old_value");
      expect(columnNames).toContain("new_value");
      expect(columnNames).toContain("created_at");
    });

    it("should enable WAL mode", () => {
      const sqliteDb = db.getDb();
      const result = sqliteDb.pragma("journal_mode") as Array<{ journal_mode: string }>;
      expect(result[0].journal_mode.toLowerCase()).toBe("wal");
    });
  });

  describe("memory CRUD operations", () => {
    it("should insert a new memory", () => {
      const sqliteDb = db.getDb();
      const memory = createTestMemory();

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

      // Verify insertion
      const selectStmt = sqliteDb.prepare("SELECT * FROM memories WHERE id = ?");
      const row = selectStmt.get(memory.id) as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.id).toBe(memory.id);
      expect(row.text).toBe(memory.text);
      expect(row.tier).toBe(memory.tier);
    });

    it("should read a memory by id", () => {
      const sqliteDb = db.getDb();
      const memory = createTestMemory({ text: "Read test memory" });

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

      const selectStmt = sqliteDb.prepare("SELECT * FROM memories WHERE id = ?");
      const row = selectStmt.get(memory.id) as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.text).toBe("Read test memory");
    });

    it("should update a memory", () => {
      const sqliteDb = db.getDb();
      const memory = createTestMemory();

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

      // Update tier and use_count
      const updateStmt = sqliteDb.prepare(`
        UPDATE memories SET tier = ?, use_count = ? WHERE id = ?
      `);
      updateStmt.run(Tier.WARM, 5, memory.id);

      const selectStmt = sqliteDb.prepare("SELECT tier, use_count FROM memories WHERE id = ?");
      const row = selectStmt.get(memory.id) as { tier: string; use_count: number };

      expect(row.tier).toBe(Tier.WARM);
      expect(row.use_count).toBe(5);
    });

    it("should delete a memory", () => {
      const sqliteDb = db.getDb();
      const memory = createTestMemory();

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

      // Delete
      const deleteStmt = sqliteDb.prepare("DELETE FROM memories WHERE id = ?");
      const result = deleteStmt.run(memory.id);

      expect(result.changes).toBe(1);

      // Verify deletion
      const selectStmt = sqliteDb.prepare("SELECT * FROM memories WHERE id = ?");
      const row = selectStmt.get(memory.id);

      expect(row).toBeUndefined();
    });

    it("should list memories by tier", () => {
      const sqliteDb = db.getDb();

      const hotMemory = createTestMemory({ tier: Tier.HOT });
      const warmMemory = createTestMemory({ tier: Tier.WARM });
      const coldMemory = createTestMemory({ tier: Tier.COLD });

      const insertStmt = sqliteDb.prepare(`
        INSERT INTO memories (id, text, importance, category, created_at, tier, memory_type, do_not_inject, pinned, use_count, last_accessed_at, use_days, source, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const memory of [hotMemory, warmMemory, coldMemory]) {
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

      const selectStmt = sqliteDb.prepare("SELECT id FROM memories WHERE tier = ?");
      const hotResults = selectStmt.all(Tier.HOT) as Array<{ id: string }>;
      const warmResults = selectStmt.all(Tier.WARM) as Array<{ id: string }>;
      const coldResults = selectStmt.all(Tier.COLD) as Array<{ id: string }>;

      expect(hotResults.length).toBe(1);
      expect(hotResults[0].id).toBe(hotMemory.id);

      expect(warmResults.length).toBe(1);
      expect(warmResults[0].id).toBe(warmMemory.id);

      expect(coldResults.length).toBe(1);
      expect(coldResults[0].id).toBe(coldMemory.id);
    });

    it("should filter memories by do_not_inject", () => {
      const sqliteDb = db.getDb();

      const visibleMemory = createTestMemory({ do_not_inject: false });
      const hiddenMemory = createTestMemory({ do_not_inject: true });

      const insertStmt = sqliteDb.prepare(`
        INSERT INTO memories (id, text, importance, category, created_at, tier, memory_type, do_not_inject, pinned, use_count, last_accessed_at, use_days, source, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const memory of [visibleMemory, hiddenMemory]) {
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

      const selectStmt = sqliteDb.prepare("SELECT id FROM memories WHERE do_not_inject = 0");
      const results = selectStmt.all() as Array<{ id: string }>;

      expect(results.length).toBe(1);
      expect(results[0].id).toBe(visibleMemory.id);
    });

    it("should filter memories by pinned status", () => {
      const sqliteDb = db.getDb();

      const pinnedMemory = createTestMemory({ pinned: true });
      const unpinnedMemory = createTestMemory({ pinned: false });

      const insertStmt = sqliteDb.prepare(`
        INSERT INTO memories (id, text, importance, category, created_at, tier, memory_type, do_not_inject, pinned, use_count, last_accessed_at, use_days, source, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const memory of [pinnedMemory, unpinnedMemory]) {
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

      const selectStmt = sqliteDb.prepare("SELECT id FROM memories WHERE pinned = 1");
      const results = selectStmt.all() as Array<{ id: string }>;

      expect(results.length).toBe(1);
      expect(results[0].id).toBe(pinnedMemory.id);
    });
  });

  describe("FTS5 sync triggers", () => {
    let fts: FTS5Helper;

    beforeEach(() => {
      fts = new FTS5Helper(db.getDb());
    });

    it("should sync FTS index on memory INSERT", () => {
      const sqliteDb = db.getDb();
      const memory = createTestMemory({ text: "Machine learning algorithms" });

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

      // Search for the inserted memory
      const results = fts.searchFTS("machine learning", 10);

      expect(results.length).toBe(1);
      expect(results[0].id).toBe(memory.id);
      expect(results[0].text).toContain("Machine learning");
    });

    it("should sync FTS index via rebuildIndex for updates", () => {
      const sqliteDb = db.getDb();
      const memory = createTestMemory({ text: "Original text content" });

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

      // Verify initial FTS
      let results = fts.searchFTS("Original", 10);
      expect(results.length).toBe(1);

      // For text updates, the safer approach is delete + insert + rebuildIndex
      // First, clear the FTS index and update the memory
      sqliteDb.exec("DELETE FROM memories_fts");
      sqliteDb.prepare("DELETE FROM memories WHERE id = ?").run(memory.id);

      // Insert with new text
      insertStmt.run(
        memory.id,
        "Updated neural network text",
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

      // Rebuild the FTS index from memories table
      fts.rebuildIndex();

      // Old text should not be found
      results = fts.searchFTS("Original", 10);
      expect(results.length).toBe(0);

      // New text should be found
      results = fts.searchFTS("neural network", 10);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(memory.id);
    });

    it("should provide rebuildIndex for FTS recovery after bulk operations", () => {
      const sqliteDb = db.getDb();

      // Insert some memories
      const memory1 = createTestMemory({ text: "First memory content" });
      const memory2 = createTestMemory({ text: "Second memory content" });

      const insertStmt = sqliteDb.prepare(`
        INSERT INTO memories (id, text, importance, category, created_at, tier, memory_type, do_not_inject, pinned, use_count, last_accessed_at, use_days, source, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const memory of [memory1, memory2]) {
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

      // Verify index count
      expect(fts.getIndexedCount()).toBe(2);

      // Search should find both
      let results = fts.searchFTS("memory content", 10);
      expect(results.length).toBe(2);

      // Rebuild should maintain the same count
      fts.rebuildIndex();
      expect(fts.getIndexedCount()).toBe(2);

      // Search should still work
      results = fts.searchFTS("First", 10);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(memory1.id);
    });

    it("should sync FTS index on memory DELETE", () => {
      const sqliteDb = db.getDb();
      const memory = createTestMemory({ text: "Deletable memory content" });

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

      // Verify initial FTS
      let results = fts.searchFTS("Deletable", 10);
      expect(results.length).toBe(1);

      // Delete the memory
      const deleteStmt = sqliteDb.prepare("DELETE FROM memories WHERE id = ?");
      deleteStmt.run(memory.id);

      // Should no longer be in FTS
      results = fts.searchFTS("Deletable", 10);
      expect(results.length).toBe(0);
    });

    it("should return BM25 ranked results", () => {
      const sqliteDb = db.getDb();

      // Create memories with different relevance
      const highRelevance = createTestMemory({
        text: "Python programming language tutorial for beginners Python Python",
      });
      const lowRelevance = createTestMemory({
        text: "General programming concepts and Python basics",
      });

      const insertStmt = sqliteDb.prepare(`
        INSERT INTO memories (id, text, importance, category, created_at, tier, memory_type, do_not_inject, pinned, use_count, last_accessed_at, use_days, source, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const memory of [highRelevance, lowRelevance]) {
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

      const results = fts.searchFTS("Python", 10);

      expect(results.length).toBe(2);
      // BM25 scores should be positive (higher is better after negation)
      expect(results[0].bm25Score).toBeGreaterThan(0);
      expect(results[1].bm25Score).toBeGreaterThan(0);
      // First result should have higher score (more Python mentions)
      expect(results[0].bm25Score).toBeGreaterThanOrEqual(results[1].bm25Score);
    });

    it("should handle empty search queries", () => {
      const results = fts.searchFTS("", 10);
      expect(results).toEqual([]);
    });

    it("should handle FTS query syntax errors gracefully", () => {
      const sqliteDb = db.getDb();
      const memory = createTestMemory({ text: "Testing special characters" });

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

      // Query with special characters that cause FTS5 syntax errors
      // should be handled with phrase search fallback (returns empty if still fails)
      expect(() => {
        fts.searchFTS("test ()", 10);
      }).not.toThrow();

      // Query with balanced quotes works as phrase search
      const results = fts.searchFTS('"Testing"', 10);
      expect(results.length).toBe(1);
    });
  });

  describe("current_context operations with TTL", () => {
    it("should insert a context entry", () => {
      const sqliteDb = db.getDb();
      const now = new Date().toISOString();
      const ttlSeconds = 14400; // 4 hours

      const insertStmt = sqliteDb.prepare(`
        INSERT INTO current_context (id, text, created_at, ttl_seconds)
        VALUES (?, ?, ?, ?)
      `);

      insertStmt.run("active", "Working on feature X", now, ttlSeconds);

      const selectStmt = sqliteDb.prepare("SELECT * FROM current_context WHERE id = ?");
      const row = selectStmt.get("active") as {
        id: string;
        text: string;
        created_at: string;
        ttl_seconds: number;
      };

      expect(row).toBeDefined();
      expect(row.id).toBe("active");
      expect(row.text).toBe("Working on feature X");
      expect(row.ttl_seconds).toBe(ttlSeconds);
    });

    it("should update context with INSERT OR REPLACE", () => {
      const sqliteDb = db.getDb();
      const now = new Date().toISOString();

      const upsertStmt = sqliteDb.prepare(`
        INSERT OR REPLACE INTO current_context (id, text, created_at, ttl_seconds)
        VALUES (?, ?, ?, ?)
      `);

      // Insert first context
      upsertStmt.run("active", "First context", now, 3600);

      // Replace with new context
      const later = new Date(Date.now() + 1000).toISOString();
      upsertStmt.run("active", "Second context", later, 7200);

      const selectStmt = sqliteDb.prepare("SELECT * FROM current_context WHERE id = ?");
      const row = selectStmt.get("active") as {
        text: string;
        ttl_seconds: number;
      };

      expect(row.text).toBe("Second context");
      expect(row.ttl_seconds).toBe(7200);
    });

    it("should delete context", () => {
      const sqliteDb = db.getDb();
      const now = new Date().toISOString();

      const insertStmt = sqliteDb.prepare(`
        INSERT INTO current_context (id, text, created_at, ttl_seconds)
        VALUES (?, ?, ?, ?)
      `);
      insertStmt.run("active", "Test context", now, 3600);

      const deleteStmt = sqliteDb.prepare("DELETE FROM current_context WHERE id = ?");
      const result = deleteStmt.run("active");

      expect(result.changes).toBe(1);

      const selectStmt = sqliteDb.prepare("SELECT * FROM current_context WHERE id = ?");
      const row = selectStmt.get("active");

      expect(row).toBeUndefined();
    });

    it("should calculate expiry from created_at and ttl_seconds", () => {
      const sqliteDb = db.getDb();
      const now = new Date();
      const ttlSeconds = 3600; // 1 hour

      const insertStmt = sqliteDb.prepare(`
        INSERT INTO current_context (id, text, created_at, ttl_seconds)
        VALUES (?, ?, ?, ?)
      `);
      insertStmt.run("active", "Test context", now.toISOString(), ttlSeconds);

      const selectStmt = sqliteDb.prepare("SELECT created_at, ttl_seconds FROM current_context WHERE id = ?");
      const row = selectStmt.get("active") as {
        created_at: string;
        ttl_seconds: number;
      };

      const createdAt = new Date(row.created_at);
      const expiresAt = new Date(createdAt.getTime() + row.ttl_seconds * 1000);

      // Expiry should be approximately 1 hour from now
      const expectedExpiry = new Date(now.getTime() + ttlSeconds * 1000);
      expect(Math.abs(expiresAt.getTime() - expectedExpiry.getTime())).toBeLessThan(1000);
    });

    it("should detect expired context based on TTL", () => {
      const sqliteDb = db.getDb();

      // Create a context that expired 1 hour ago
      const oneHourAgo = new Date(Date.now() - 3600 * 1000);
      const ttlSeconds = 1800; // 30 minutes

      const insertStmt = sqliteDb.prepare(`
        INSERT INTO current_context (id, text, created_at, ttl_seconds)
        VALUES (?, ?, ?, ?)
      `);
      insertStmt.run("active", "Expired context", oneHourAgo.toISOString(), ttlSeconds);

      const selectStmt = sqliteDb.prepare("SELECT created_at, ttl_seconds FROM current_context WHERE id = ?");
      const row = selectStmt.get("active") as {
        created_at: string;
        ttl_seconds: number;
      };

      const createdAt = new Date(row.created_at);
      const expiresAt = new Date(createdAt.getTime() + row.ttl_seconds * 1000);
      const now = new Date();

      // Context should be expired
      expect(now.getTime()).toBeGreaterThan(expiresAt.getTime());
    });

    it("should detect valid (non-expired) context based on TTL", () => {
      const sqliteDb = db.getDb();
      const now = new Date();
      const ttlSeconds = 7200; // 2 hours

      const insertStmt = sqliteDb.prepare(`
        INSERT INTO current_context (id, text, created_at, ttl_seconds)
        VALUES (?, ?, ?, ?)
      `);
      insertStmt.run("active", "Valid context", now.toISOString(), ttlSeconds);

      const selectStmt = sqliteDb.prepare("SELECT created_at, ttl_seconds FROM current_context WHERE id = ?");
      const row = selectStmt.get("active") as {
        created_at: string;
        ttl_seconds: number;
      };

      const createdAt = new Date(row.created_at);
      const expiresAt = new Date(createdAt.getTime() + row.ttl_seconds * 1000);
      const checkTime = new Date();

      // Context should not be expired
      expect(checkTime.getTime()).toBeLessThan(expiresAt.getTime());
    });
  });

  describe("audit log creation", () => {
    it("should insert an audit entry", () => {
      const sqliteDb = db.getDb();
      const memory = createTestMemory();

      // First insert a memory
      const insertMemoryStmt = sqliteDb.prepare(`
        INSERT INTO memories (id, text, importance, category, created_at, tier, memory_type, do_not_inject, pinned, use_count, last_accessed_at, use_days, source, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertMemoryStmt.run(
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

      // Insert audit entry
      const auditId = randomUUID();
      const now = new Date().toISOString();
      const insertAuditStmt = sqliteDb.prepare(`
        INSERT INTO memory_audit (id, memory_id, action, old_value, new_value, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      insertAuditStmt.run(
        auditId,
        memory.id,
        "forget",
        JSON.stringify({ do_not_inject: false }),
        JSON.stringify({ do_not_inject: true }),
        now
      );

      const selectStmt = sqliteDb.prepare("SELECT * FROM memory_audit WHERE id = ?");
      const row = selectStmt.get(auditId) as MemoryAudit;

      expect(row).toBeDefined();
      expect(row.memory_id).toBe(memory.id);
      expect(row.action).toBe("forget");
      expect(row.old_value).toBe(JSON.stringify({ do_not_inject: false }));
      expect(row.new_value).toBe(JSON.stringify({ do_not_inject: true }));
    });

    it("should query audit entries by memory_id", () => {
      const sqliteDb = db.getDb();
      const memory = createTestMemory();

      // Insert memory
      const insertMemoryStmt = sqliteDb.prepare(`
        INSERT INTO memories (id, text, importance, category, created_at, tier, memory_type, do_not_inject, pinned, use_count, last_accessed_at, use_days, source, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertMemoryStmt.run(
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

      // Insert multiple audit entries
      const insertAuditStmt = sqliteDb.prepare(`
        INSERT INTO memory_audit (id, memory_id, action, old_value, new_value, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();
      insertAuditStmt.run(randomUUID(), memory.id, "pin", null, JSON.stringify({ pinned: true }), new Date(now).toISOString());
      insertAuditStmt.run(randomUUID(), memory.id, "demote", JSON.stringify({ tier: "HOT" }), JSON.stringify({ tier: "COLD" }), new Date(now + 1000).toISOString());
      insertAuditStmt.run(randomUUID(), memory.id, "unpin", JSON.stringify({ pinned: true }), JSON.stringify({ pinned: false }), new Date(now + 2000).toISOString());

      const selectStmt = sqliteDb.prepare("SELECT * FROM memory_audit WHERE memory_id = ? ORDER BY created_at");
      const rows = selectStmt.all(memory.id) as MemoryAudit[];

      expect(rows.length).toBe(3);
      expect(rows[0].action).toBe("pin");
      expect(rows[1].action).toBe("demote");
      expect(rows[2].action).toBe("unpin");
    });

    it("should cascade delete audit entries when memory is deleted", () => {
      const sqliteDb = db.getDb();
      const memory = createTestMemory();

      // Insert memory
      const insertMemoryStmt = sqliteDb.prepare(`
        INSERT INTO memories (id, text, importance, category, created_at, tier, memory_type, do_not_inject, pinned, use_count, last_accessed_at, use_days, source, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertMemoryStmt.run(
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

      // Insert audit entry
      const insertAuditStmt = sqliteDb.prepare(`
        INSERT INTO memory_audit (id, memory_id, action, old_value, new_value, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      insertAuditStmt.run(randomUUID(), memory.id, "forget", null, null, new Date().toISOString());

      // Verify audit exists
      let auditRows = sqliteDb.prepare("SELECT * FROM memory_audit WHERE memory_id = ?").all(memory.id);
      expect(auditRows.length).toBe(1);

      // Enable foreign keys to test cascade (may need to be enabled per connection)
      sqliteDb.pragma("foreign_keys = ON");

      // Delete memory
      sqliteDb.prepare("DELETE FROM memories WHERE id = ?").run(memory.id);

      // Audit entries should be cascade deleted
      auditRows = sqliteDb.prepare("SELECT * FROM memory_audit WHERE memory_id = ?").all(memory.id);
      expect(auditRows.length).toBe(0);
    });

    it("should store different action types", () => {
      const sqliteDb = db.getDb();
      const memory = createTestMemory();

      // Insert memory
      const insertMemoryStmt = sqliteDb.prepare(`
        INSERT INTO memories (id, text, importance, category, created_at, tier, memory_type, do_not_inject, pinned, use_count, last_accessed_at, use_days, source, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertMemoryStmt.run(
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

      const insertAuditStmt = sqliteDb.prepare(`
        INSERT INTO memory_audit (id, memory_id, action, old_value, new_value, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const actions = ["forget", "restore", "pin", "unpin", "demote", "promote"];
      for (const action of actions) {
        insertAuditStmt.run(randomUUID(), memory.id, action, null, null, new Date().toISOString());
      }

      const selectStmt = sqliteDb.prepare("SELECT DISTINCT action FROM memory_audit WHERE memory_id = ?");
      const rows = selectStmt.all(memory.id) as Array<{ action: string }>;
      const storedActions = rows.map((r) => r.action);

      for (const action of actions) {
        expect(storedActions).toContain(action);
      }
    });
  });

  describe("Database utility methods", () => {
    it("should expose the underlying sqlite3 database", () => {
      const sqliteDb = db.getDb();
      expect(sqliteDb).toBeDefined();
      expect(typeof sqliteDb.prepare).toBe("function");
    });

    it("should report open status correctly", () => {
      expect(db.isOpen()).toBe(true);

      db.close();
      expect(db.isOpen()).toBe(false);
    });

    it("should support retry wrapper for operations", () => {
      const sqliteDb = db.getDb();

      // Simple operation that should succeed
      const result = db.withRetry(() => {
        return sqliteDb.prepare("SELECT 1 as value").get() as { value: number };
      });

      expect(result.value).toBe(1);
    });

    it("should support execWithRetry for SQL execution", () => {
      // Should not throw
      expect(() => {
        db.execWithRetry("CREATE TABLE IF NOT EXISTS test_retry (id TEXT)");
      }).not.toThrow();

      // Verify table was created
      const sqliteDb = db.getDb();
      const tableInfo = sqliteDb.prepare("PRAGMA table_info(test_retry)").all();
      expect(tableInfo.length).toBeGreaterThan(0);
    });

    it("should support runWithRetry for statements", () => {
      const sqliteDb = db.getDb();

      db.execWithRetry("CREATE TABLE IF NOT EXISTS test_run_retry (id TEXT PRIMARY KEY, value TEXT)");
      const stmt = sqliteDb.prepare("INSERT INTO test_run_retry (id, value) VALUES (?, ?)");

      const result = db.runWithRetry(stmt, "test-id", "test-value");
      expect(result.changes).toBe(1);
    });

    it("should support getWithRetry for single row queries", () => {
      const sqliteDb = db.getDb();

      db.execWithRetry("CREATE TABLE IF NOT EXISTS test_get_retry (id TEXT PRIMARY KEY, value TEXT)");
      sqliteDb.prepare("INSERT INTO test_get_retry (id, value) VALUES (?, ?)").run("test-id", "test-value");

      const stmt = sqliteDb.prepare("SELECT * FROM test_get_retry WHERE id = ?");
      const row = db.getWithRetry<{ id: string; value: string }>(stmt, "test-id");

      expect(row?.id).toBe("test-id");
      expect(row?.value).toBe("test-value");
    });

    it("should support allWithRetry for multiple row queries", () => {
      const sqliteDb = db.getDb();

      db.execWithRetry("CREATE TABLE IF NOT EXISTS test_all_retry (id TEXT PRIMARY KEY, value TEXT)");
      sqliteDb.prepare("INSERT INTO test_all_retry (id, value) VALUES (?, ?)").run("id1", "value1");
      sqliteDb.prepare("INSERT INTO test_all_retry (id, value) VALUES (?, ?)").run("id2", "value2");

      const stmt = sqliteDb.prepare("SELECT * FROM test_all_retry ORDER BY id");
      const rows = db.allWithRetry<{ id: string; value: string }>(stmt);

      expect(rows.length).toBe(2);
      expect(rows[0].id).toBe("id1");
      expect(rows[1].id).toBe("id2");
    });
  });
});
