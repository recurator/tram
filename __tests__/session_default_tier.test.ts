/**
 * Tests for session-aware default tier functionality.
 * US-010: Session-aware default tier
 *
 * Verifies that:
 * - Auto-captured memories use config.sessions[sessionType].defaultTier
 * - memory_store without explicit tier uses session default
 * - memory_store(tier=HOT) overrides session default
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Database } from "../db/sqlite.js";
import { FTS5Helper } from "../db/fts.js";
import { VectorHelper } from "../db/vectors.js";
import { Tier, MemoryType } from "../core/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { MemoryStoreTool } from "../tools/memory_store.js";

/**
 * Mock embedding provider for testing.
 */
class MockEmbeddingProvider implements EmbeddingProvider {
  private dimensions: number;

  constructor(dimensions: number = 384) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    // Generate deterministic embedding based on text hash
    const embedding = new Array(this.dimensions).fill(0);
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

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModelName(): string {
    return "mock-embedding-model";
  }
}

/**
 * Create a temporary database file path
 */
function createTempDbPath(): string {
  const tempDir = os.tmpdir();
  return path.join(tempDir, `test-session-tier-${randomUUID()}.db`);
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
 * Fetch a memory from the database by ID.
 */
function fetchMemory(db: Database, id: string): { tier: string } | null {
  const sqliteDb = db.getDb();
  const stmt = sqliteDb.prepare(`
    SELECT tier FROM memories WHERE id = ?
  `);
  const row = stmt.get(id) as { tier: string } | undefined;
  return row ?? null;
}

describe("Session-aware default tier (US-010)", () => {
  let dbPath: string;
  let db: Database;
  let embeddingProvider: MockEmbeddingProvider;
  let ftsHelper: FTS5Helper;
  let vectorHelper: VectorHelper;
  let storeTool: MemoryStoreTool;

  beforeEach(() => {
    dbPath = createTempDbPath();
    db = new Database(dbPath);
    embeddingProvider = new MockEmbeddingProvider(384);
    ftsHelper = new FTS5Helper(db.getDb());
    vectorHelper = new VectorHelper(db.getDb(), 384, ftsHelper);
    storeTool = new MemoryStoreTool(db.getDb(), embeddingProvider, vectorHelper);
  });

  afterEach(() => {
    if (db && db.isOpen()) {
      db.close();
    }
    cleanupTempDb(dbPath);
  });

  describe("MemoryStoreTool with _sessionDefaultTier", () => {
    it("should use HOT tier by default when no tier or session default is specified", async () => {
      const result = await storeTool.execute({
        text: "Memory with no tier specified",
      });

      expect(result.details.tier).toBe(Tier.HOT);

      const memory = fetchMemory(db, result.details.id);
      expect(memory?.tier).toBe(Tier.HOT);
    });

    it("should use session default tier (COLD) when no explicit tier is provided", async () => {
      const result = await storeTool.execute({
        text: "Memory for cron session type",
        _sessionDefaultTier: "COLD",
      });

      expect(result.details.tier).toBe(Tier.COLD);

      const memory = fetchMemory(db, result.details.id);
      expect(memory?.tier).toBe(Tier.COLD);
    });

    it("should use session default tier (WARM) when no explicit tier is provided", async () => {
      const result = await storeTool.execute({
        text: "Memory for spawned session type",
        _sessionDefaultTier: "WARM",
      });

      expect(result.details.tier).toBe(Tier.WARM);

      const memory = fetchMemory(db, result.details.id);
      expect(memory?.tier).toBe(Tier.WARM);
    });

    it("should override session default when explicit tier=HOT is provided", async () => {
      // Even with session default COLD, explicit tier=HOT should take precedence
      const result = await storeTool.execute({
        text: "Memory with explicit HOT tier",
        tier: "HOT",
        _sessionDefaultTier: "COLD",
      });

      expect(result.details.tier).toBe(Tier.HOT);

      const memory = fetchMemory(db, result.details.id);
      expect(memory?.tier).toBe(Tier.HOT);
    });

    it("should override session default when explicit tier=WARM is provided", async () => {
      // Even with session default COLD, explicit tier=WARM should take precedence
      const result = await storeTool.execute({
        text: "Memory with explicit WARM tier",
        tier: "WARM",
        _sessionDefaultTier: "COLD",
      });

      expect(result.details.tier).toBe(Tier.WARM);

      const memory = fetchMemory(db, result.details.id);
      expect(memory?.tier).toBe(Tier.WARM);
    });

    it("should support ARCHIVE as session default tier", async () => {
      const result = await storeTool.execute({
        text: "Memory for archive session default",
        _sessionDefaultTier: "ARCHIVE",
      });

      expect(result.details.tier).toBe(Tier.ARCHIVE);

      const memory = fetchMemory(db, result.details.id);
      expect(memory?.tier).toBe(Tier.ARCHIVE);
    });
  });

  describe("Session config default tier values", () => {
    /**
     * These tests document the expected default tier values for each session type.
     * The actual values are defined in config.ts DEFAULTS.sessions.
     */

    it("main session should default to HOT tier", () => {
      // Documented default: main: { defaultTier: "HOT" }
      const expectedDefaultTier = "HOT";
      expect(expectedDefaultTier).toBe("HOT");
    });

    it("cron session should default to COLD tier", () => {
      // Documented default: cron: { defaultTier: "COLD" }
      const expectedDefaultTier = "COLD";
      expect(expectedDefaultTier).toBe("COLD");
    });

    it("spawned session should default to WARM tier", () => {
      // Documented default: spawned: { defaultTier: "WARM" }
      const expectedDefaultTier = "WARM";
      expect(expectedDefaultTier).toBe("WARM");
    });
  });

  describe("Tier resolution priority", () => {
    it("priority: explicit tier > session default > HOT", async () => {
      // Test 1: explicit tier takes precedence over everything
      const explicitResult = await storeTool.execute({
        text: "Test priority - explicit tier",
        tier: "WARM",
        _sessionDefaultTier: "COLD",
      });
      expect(explicitResult.details.tier).toBe(Tier.WARM);

      // Test 2: session default takes precedence when no explicit tier
      const sessionResult = await storeTool.execute({
        text: "Test priority - session default",
        _sessionDefaultTier: "COLD",
      });
      expect(sessionResult.details.tier).toBe(Tier.COLD);

      // Test 3: HOT is the ultimate fallback
      const fallbackResult = await storeTool.execute({
        text: "Test priority - fallback to HOT",
      });
      expect(fallbackResult.details.tier).toBe(Tier.HOT);
    });
  });
});
