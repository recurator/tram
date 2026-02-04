/**
 * Unit tests for DecayEngine category-aware decay
 *
 * Tests that:
 *   - DecayEngine looks up TTL from config.decay.overrides[memory.memory_type]
 *   - Falls back to config.decay.default when no override exists
 *   - null TTL means memory never demotes from that tier
 *   - Audit log entry includes memory_type in context
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Database } from "../db/sqlite.js";
import { DecayEngine } from "../core/decay.js";
import { Tier, MemoryType, type Memory } from "../core/types.js";
import type { ResolvedConfig, MemoryTypeValue } from "../config.js";

/**
 * Create a temporary database file path
 */
function createTempDbPath(): string {
  const tempDir = os.tmpdir();
  return path.join(tempDir, `test-decay-${randomUUID()}.db`);
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
 * Get a memory from the database by ID
 */
function getMemory(db: Database, id: string): Memory | null {
  const sqliteDb = db.getDb();
  const row = sqliteDb.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as {
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

  if (!row) return null;

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
    use_days: JSON.parse(row.use_days),
    source: row.source,
    parent_id: row.parent_id,
  };
}

describe("DecayEngine", () => {
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

  describe("category-aware decay", () => {
    it("should use default TTL when no override exists for memory type", () => {
      // Create an old HOT memory (older than default 72 hours by last_accessed_at)
      const oldDate = new Date();
      oldDate.setHours(oldDate.getHours() - 100); // 100 hours since last access
      const memory = createTestMemory({
        tier: Tier.HOT,
        memory_type: MemoryType.factual,
        last_accessed_at: oldDate.toISOString(),
      });

      insertMemory(db,memory);

      // Create decay engine with default config (no overrides)
      const config: Partial<ResolvedConfig> = {
        decay: {
          intervalHours: 6,
          default: { hotTTL: 72, warmTTL: 60, coldTTL: 180 },
          overrides: {} as Record<MemoryTypeValue, { hotTTL: number | null; warmTTL: number | null; coldTTL?: number | null }>,
        },
      };

      const engine = new DecayEngine(db.getDb(), config);
      const result = engine.run();

      expect(result.hotDemoted).toBe(1);
      // Memory is processed twice: once as HOT (demoted), once as WARM (checked but not demoted)
      // because warmTTL is 60 days and memory is only 100 hours (~4 days) old
      expect(result.totalProcessed).toBe(2);

      // Verify memory was demoted to WARM (linear decay: HOT→WARM)
      const updated = getMemory(db,memory.id);
      expect(updated?.tier).toBe(Tier.WARM);
    });

    it("should use override TTL when specified for memory type", () => {
      // Create an old HOT episodic memory (older than override 24 hours by last_accessed_at)
      const oldDate = new Date();
      oldDate.setHours(oldDate.getHours() - 30); // 30 hours since last access
      const memory = createTestMemory({
        tier: Tier.HOT,
        memory_type: MemoryType.episodic,
        last_accessed_at: oldDate.toISOString(),
      });

      insertMemory(db,memory);

      // Create decay engine with episodic override (24 hours)
      const config: Partial<ResolvedConfig> = {
        decay: {
          intervalHours: 6,
          default: { hotTTL: 72, warmTTL: 60, coldTTL: 180 },
          overrides: {
            episodic: { hotTTL: 24, warmTTL: 30 },
          } as Record<MemoryTypeValue, { hotTTL: number | null; warmTTL: number | null; coldTTL?: number | null }>,
        },
      };

      const engine = new DecayEngine(db.getDb(), config);
      const result = engine.run();

      // Memory is 30h since last access, override is 24h, so should be demoted
      expect(result.hotDemoted).toBe(1);

      // Linear decay: HOT→WARM
      const updated = getMemory(db,memory.id);
      expect(updated?.tier).toBe(Tier.WARM);
    });

    it("should NOT demote when override TTL is not exceeded", () => {
      // Create a HOT factual memory that is 50 hours since last access
      const oldDate = new Date();
      oldDate.setHours(oldDate.getHours() - 50);
      const memory = createTestMemory({
        tier: Tier.HOT,
        memory_type: MemoryType.factual,
        last_accessed_at: oldDate.toISOString(),
      });

      insertMemory(db,memory);

      // Create decay engine with factual override of 100 hours
      const config: Partial<ResolvedConfig> = {
        decay: {
          intervalHours: 6,
          default: { hotTTL: 72, warmTTL: 60, coldTTL: 180 },
          overrides: {
            factual: { hotTTL: 100, warmTTL: 90 },
          } as Record<MemoryTypeValue, { hotTTL: number | null; warmTTL: number | null; coldTTL?: number | null }>,
        },
      };

      const engine = new DecayEngine(db.getDb(), config);
      const result = engine.run();

      // Memory is 50h since last access, override is 100h, so should NOT be demoted
      expect(result.hotDemoted).toBe(0);

      const updated = getMemory(db,memory.id);
      expect(updated?.tier).toBe(Tier.HOT);
    });

    it("should never demote when hotTTL is null", () => {
      // Create a very old HOT procedural memory by last_accessed_at
      const oldDate = new Date();
      oldDate.setHours(oldDate.getHours() - 1000); // 1000 hours since last access
      const memory = createTestMemory({
        tier: Tier.HOT,
        memory_type: MemoryType.procedural,
        last_accessed_at: oldDate.toISOString(),
      });

      insertMemory(db,memory);

      // Create decay engine with procedural hotTTL: null (never demote)
      const config: Partial<ResolvedConfig> = {
        decay: {
          intervalHours: 6,
          default: { hotTTL: 72, warmTTL: 60, coldTTL: 180 },
          overrides: {
            procedural: { hotTTL: null, warmTTL: null },
          } as Record<MemoryTypeValue, { hotTTL: number | null; warmTTL: number | null; coldTTL?: number | null }>,
        },
      };

      const engine = new DecayEngine(db.getDb(), config);
      const result = engine.run();

      // null TTL means never demote, even though it's 1000 hours old
      expect(result.hotDemoted).toBe(0);

      const updated = getMemory(db,memory.id);
      expect(updated?.tier).toBe(Tier.HOT);
    });

    it("should never demote from WARM when warmTTL is null", () => {
      // Create a very old WARM project memory
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 200); // 200 days ago
      const memory = createTestMemory({
        tier: Tier.WARM,
        memory_type: MemoryType.project,
        created_at: oldDate.toISOString(),
        last_accessed_at: oldDate.toISOString(),
      });

      insertMemory(db,memory);

      // Create decay engine with project warmTTL: null (never demote)
      const config: Partial<ResolvedConfig> = {
        decay: {
          intervalHours: 6,
          default: { hotTTL: 72, warmTTL: 60, coldTTL: 180 },
          overrides: {
            project: { hotTTL: 48, warmTTL: null },
          } as Record<MemoryTypeValue, { hotTTL: number | null; warmTTL: number | null; coldTTL?: number | null }>,
        },
      };

      const engine = new DecayEngine(db.getDb(), config);
      const result = engine.run();

      // null warmTTL means never demote from WARM
      expect(result.warmDemoted).toBe(0);

      const updated = getMemory(db,memory.id);
      expect(updated?.tier).toBe(Tier.WARM);
    });

    it("should include memory_type in audit log context", () => {
      // Create an old HOT memory by last_accessed_at
      const oldDate = new Date();
      oldDate.setHours(oldDate.getHours() - 100);
      const memory = createTestMemory({
        tier: Tier.HOT,
        memory_type: MemoryType.episodic,
        last_accessed_at: oldDate.toISOString(),
      });

      insertMemory(db,memory);

      const config: Partial<ResolvedConfig> = {
        decay: {
          intervalHours: 6,
          default: { hotTTL: 72, warmTTL: 60, coldTTL: 180 },
          overrides: {} as Record<MemoryTypeValue, { hotTTL: number | null; warmTTL: number | null; coldTTL?: number | null }>,
        },
      };

      const engine = new DecayEngine(db.getDb(), config);
      engine.run();

      // Check audit log for memory_type in context
      const sqliteDb = db.getDb();
      const auditEntry = sqliteDb.prepare(`
        SELECT old_value, new_value FROM memory_audit
        WHERE memory_id = ? AND action = 'demote'
        ORDER BY created_at DESC LIMIT 1
      `).get(memory.id) as { old_value: string; new_value: string } | undefined;

      expect(auditEntry).toBeDefined();
      const oldValue = JSON.parse(auditEntry!.old_value);
      const newValue = JSON.parse(auditEntry!.new_value);

      expect(oldValue.memory_type).toBe("episodic");
      expect(newValue.memory_type).toBe("episodic");
      expect(oldValue.tier).toBe("HOT");
      // Linear decay: HOT→WARM
      expect(newValue.tier).toBe("WARM");
    });

    it("should handle mixed memory types with different TTLs", () => {
      const now = new Date();

      // Create memories with different types and ages (by last_accessed_at)
      // Episodic: 30h since last access (override 24h TTL -> should demote)
      const episodicDate = new Date(now);
      episodicDate.setHours(episodicDate.getHours() - 30);
      const episodicMemory = createTestMemory({
        tier: Tier.HOT,
        memory_type: MemoryType.episodic,
        last_accessed_at: episodicDate.toISOString(),
      });

      // Factual: 50h since last access (default 72h TTL -> should NOT demote)
      const factualDate = new Date(now);
      factualDate.setHours(factualDate.getHours() - 50);
      const factualMemory = createTestMemory({
        tier: Tier.HOT,
        memory_type: MemoryType.factual,
        last_accessed_at: factualDate.toISOString(),
      });

      // Procedural: 1000h since last access (null TTL -> should NEVER demote)
      const proceduralDate = new Date(now);
      proceduralDate.setHours(proceduralDate.getHours() - 1000);
      const proceduralMemory = createTestMemory({
        tier: Tier.HOT,
        memory_type: MemoryType.procedural,
        last_accessed_at: proceduralDate.toISOString(),
      });

      insertMemory(db,episodicMemory);
      insertMemory(db,factualMemory);
      insertMemory(db,proceduralMemory);

      const config: Partial<ResolvedConfig> = {
        decay: {
          intervalHours: 6,
          default: { hotTTL: 72, warmTTL: 60, coldTTL: 180 },
          overrides: {
            episodic: { hotTTL: 24, warmTTL: 10 },
            procedural: { hotTTL: null, warmTTL: null },
          } as Record<MemoryTypeValue, { hotTTL: number | null; warmTTL: number | null; coldTTL?: number | null }>,
        },
      };

      const engine = new DecayEngine(db.getDb(), config);
      const result = engine.run();

      // Only episodic should be demoted from HOT
      expect(result.hotDemoted).toBe(1);
      // 3 HOT memories processed + 1 newly demoted WARM memory checked = 4 total
      expect(result.totalProcessed).toBe(4);

      // Verify each memory's final tier (linear decay: HOT→WARM)
      expect(getMemory(db,episodicMemory.id)?.tier).toBe(Tier.WARM);
      expect(getMemory(db,factualMemory.id)?.tier).toBe(Tier.HOT);
      expect(getMemory(db,proceduralMemory.id)?.tier).toBe(Tier.HOT);
    });

    it("should use WARM override TTL for WARM tier memories", () => {
      const now = new Date();

      // WARM episodic memory: 15 days inactive (override 10 days -> should demote)
      const episodicDate = new Date(now);
      episodicDate.setDate(episodicDate.getDate() - 15);
      const episodicMemory = createTestMemory({
        tier: Tier.WARM,
        memory_type: MemoryType.episodic,
        created_at: episodicDate.toISOString(),
        last_accessed_at: episodicDate.toISOString(),
      });

      // WARM factual memory: 50 days inactive (default 60 days -> should NOT demote)
      const factualDate = new Date(now);
      factualDate.setDate(factualDate.getDate() - 50);
      const factualMemory = createTestMemory({
        tier: Tier.WARM,
        memory_type: MemoryType.factual,
        created_at: factualDate.toISOString(),
        last_accessed_at: factualDate.toISOString(),
      });

      insertMemory(db,episodicMemory);
      insertMemory(db,factualMemory);

      const config: Partial<ResolvedConfig> = {
        decay: {
          intervalHours: 6,
          default: { hotTTL: 72, warmTTL: 60, coldTTL: 180 },
          overrides: {
            episodic: { hotTTL: 24, warmTTL: 10 },
          } as Record<MemoryTypeValue, { hotTTL: number | null; warmTTL: number | null; coldTTL?: number | null }>,
        },
      };

      const engine = new DecayEngine(db.getDb(), config);
      const result = engine.run();

      // Only episodic should be demoted (15 days > 10 day override)
      // Factual should stay (50 days < 60 day default)
      expect(result.warmDemoted).toBe(1);

      expect(getMemory(db,episodicMemory.id)?.tier).toBe(Tier.COLD);
      expect(getMemory(db,factualMemory.id)?.tier).toBe(Tier.WARM);
    });
  });
});
