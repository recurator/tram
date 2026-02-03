/**
 * Vector search operations using sqlite-vec with cosine similarity fallback.
 * Provides semantic similarity search for memory embeddings.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as SqliteDb, Statement } from "better-sqlite3";
import { FTS5Helper, type FTSSearchResult } from "./fts.js";

/**
 * Result from a vector similarity search.
 */
export interface VectorSearchResult {
  /** Memory ID */
  id: string;
  /** Memory text content */
  text: string;
  /** Cosine similarity score (0 to 1, higher is more similar) */
  similarity: number;
}

/**
 * Result from a hybrid search combining FTS and vector similarity.
 */
export interface HybridSearchResult {
  /** Memory ID */
  id: string;
  /** Memory text content */
  text: string;
  /** Combined score (higher is more relevant) */
  score: number;
  /** Vector similarity component (0 to 1) */
  vectorScore: number;
  /** Text match component (normalized BM25, 0 to 1) */
  textScore: number;
}

/**
 * Options for hybrid search.
 */
export interface HybridSearchOptions {
  /** Maximum number of results (default: 10) */
  limit?: number;
  /** Weight for vector similarity (default: 0.7) */
  vectorWeight?: number;
  /** Weight for text matching (default: 0.3) */
  textWeight?: number;
}

/**
 * Vector search helper class providing semantic similarity search.
 * Attempts to use sqlite-vec extension for efficient search, falling back
 * to in-process cosine similarity when extension is unavailable.
 */
export class VectorHelper {
  private db: SqliteDb;
  private sqliteVecAvailable: boolean = false;
  private dimensions: number;
  private searchStmt: Statement | null = null;
  private ftsHelper: FTS5Helper | null = null;

  /**
   * Create a new VectorHelper instance.
   * @param db - The better-sqlite3 database instance
   * @param dimensions - The dimensionality of embedding vectors
   * @param ftsHelper - Optional FTS5Helper for hybrid search (pass existing instance to share)
   */
  constructor(db: SqliteDb, dimensions: number, ftsHelper?: FTS5Helper) {
    this.db = db;
    this.dimensions = dimensions;
    this.ftsHelper = ftsHelper ?? null;
    this.initialize();
  }

  /**
   * Initialize vector storage, attempting to load sqlite-vec extension.
   */
  private initialize(): void {
    // Try to load sqlite-vec extension
    try {
      // Common extension paths to try
      // sqlite-vec npm package puts binaries in platform-specific subdirectories
      const extensionPaths: string[] = [
        "vec0",
        "./vec0",
        "sqlite-vec",
        "./sqlite-vec",
      ];

      // Find sqlite-vec binary in node_modules
      // Walk up from current file to find node_modules
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const searchDirs = [
        join(currentDir, "..", "node_modules"),
        join(currentDir, "..", "..", "node_modules"),
        join(currentDir, "..", "..", "..", "node_modules"),
      ];

      const platformPackages = [
        { pkg: "sqlite-vec-linux-arm64", ext: "so" },
        { pkg: "sqlite-vec-linux-x64", ext: "so" },
        { pkg: "sqlite-vec-darwin-arm64", ext: "dylib" },
        { pkg: "sqlite-vec-darwin-x64", ext: "dylib" },
        { pkg: "sqlite-vec-win32-x64", ext: "dll" },
      ];

      for (const dir of searchDirs) {
        for (const { pkg, ext } of platformPackages) {
          const fullPath = join(dir, pkg, `vec0.${ext}`);
          if (existsSync(fullPath)) {
            // loadExtension wants path without extension
            extensionPaths.push(fullPath.replace(new RegExp(`\\.${ext}$`), ""));
          }
        }
      }

      let loaded = false;
      for (const path of extensionPaths) {
        try {
          this.db.loadExtension(path);
          loaded = true;
          break;
        } catch {
          // Try next path
        }
      }

      if (loaded) {
        this.sqliteVecAvailable = true;
        this.createVecTable();
      } else {
        throw new Error("No extension path worked");
      }
    } catch {
      // sqlite-vec not available, will use cosine fallback
      this.sqliteVecAvailable = false;
      console.warn(
        "[tram] sqlite-vec extension not available. " +
        "Falling back to in-process cosine similarity. " +
        "For better performance, install sqlite-vec: npm install sqlite-vec"
      );
      this.createFallbackTable();
    }
  }

  /**
   * Create vec0 virtual table for sqlite-vec based vector search.
   */
  private createVecTable(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding FLOAT[${this.dimensions}]
      )
    `);
  }

  /**
   * Create fallback table for storing embeddings when sqlite-vec unavailable.
   */
  private createFallbackTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_vectors (
        memory_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      )
    `);
  }

  /**
   * Store an embedding vector for a memory.
   * @param memoryId - The memory ID
   * @param embedding - The embedding vector
   */
  storeEmbedding(memoryId: string, embedding: number[]): void {
    if (this.sqliteVecAvailable) {
      // sqlite-vec uses JSON array format
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO memory_vectors (memory_id, embedding)
        VALUES (?, ?)
      `);
      stmt.run(memoryId, JSON.stringify(embedding));
    } else {
      // Store as binary blob for fallback
      const buffer = Buffer.from(new Float32Array(embedding).buffer);
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO memory_vectors (memory_id, embedding)
        VALUES (?, ?)
      `);
      stmt.run(memoryId, buffer);
    }
  }

  /**
   * Delete an embedding vector for a memory.
   * @param memoryId - The memory ID
   */
  deleteEmbedding(memoryId: string): void {
    const stmt = this.db.prepare(`DELETE FROM memory_vectors WHERE memory_id = ?`);
    stmt.run(memoryId);
  }

  /**
   * Search for similar memories using vector similarity.
   * @param queryEmbedding - The query embedding vector
   * @param limit - Maximum number of results (default: 10)
   * @returns Array of search results with similarity scores
   */
  vectorSearch(queryEmbedding: number[], limit: number = 10): VectorSearchResult[] {
    if (this.sqliteVecAvailable) {
      return this.vectorSearchSqliteVec(queryEmbedding, limit);
    } else {
      return this.vectorSearchCosineFallback(queryEmbedding, limit);
    }
  }

  /**
   * Hybrid search combining FTS5 text matching with vector similarity.
   * @param query - The text query for FTS search
   * @param queryEmbedding - The query embedding vector for semantic search
   * @param options - Search options (limit, weights)
   * @returns Array of hybrid search results sorted by combined score
   */
  hybridSearch(
    query: string,
    queryEmbedding: number[],
    options: HybridSearchOptions = {}
  ): HybridSearchResult[] {
    const {
      limit = 10,
      vectorWeight = 0.7,
      textWeight = 0.3,
    } = options;

    // Initialize FTS helper if needed
    if (!this.ftsHelper) {
      this.ftsHelper = new FTS5Helper(this.db);
    }

    // Run both searches in parallel (not truly parallel, but batched)
    // Fetch more candidates than limit to ensure good coverage after merge
    const candidateLimit = Math.max(limit * 3, 30);

    // Get FTS results
    const ftsResults = this.ftsHelper.searchFTS(query, candidateLimit);

    // Get vector results
    const vectorResults = this.vectorSearch(queryEmbedding, candidateLimit);

    // Normalize FTS BM25 scores to 0-1 range
    // BM25 scores are already positive after negation in FTS5Helper
    const maxBm25 = Math.max(...ftsResults.map((r) => r.bm25Score), 0.001);
    const normalizedFts = new Map<string, { text: string; score: number }>();
    for (const result of ftsResults) {
      normalizedFts.set(result.id, {
        text: result.text,
        score: result.bm25Score / maxBm25,
      });
    }

    // Vector scores are already 0-1 (cosine similarity)
    const vectorMap = new Map<string, { text: string; score: number }>();
    for (const result of vectorResults) {
      vectorMap.set(result.id, {
        text: result.text,
        score: result.similarity,
      });
    }

    // Merge results - union of both result sets
    const allIds = new Set([...normalizedFts.keys(), ...vectorMap.keys()]);
    const hybridResults: HybridSearchResult[] = [];

    for (const id of allIds) {
      const ftsEntry = normalizedFts.get(id);
      const vectorEntry = vectorMap.get(id);

      // Use text from whichever source has it
      const text = ftsEntry?.text ?? vectorEntry?.text ?? "";

      // Get scores (0 if not found in that search)
      const textScore = ftsEntry?.score ?? 0;
      const vectorScore = vectorEntry?.score ?? 0;

      // Calculate combined score
      const score = vectorWeight * vectorScore + textWeight * textScore;

      hybridResults.push({
        id,
        text,
        score,
        vectorScore,
        textScore,
      });
    }

    // Sort by combined score descending
    hybridResults.sort((a, b) => b.score - a.score);

    // Return top results up to limit
    return hybridResults.slice(0, limit);
  }

  /**
   * Set the FTS5Helper instance for hybrid search.
   * Use this to share an FTS5Helper instance across helpers.
   */
  setFtsHelper(ftsHelper: FTS5Helper): void {
    this.ftsHelper = ftsHelper;
  }

  /**
   * Vector search using sqlite-vec extension.
   */
  private vectorSearchSqliteVec(queryEmbedding: number[], limit: number): VectorSearchResult[] {
    // sqlite-vec provides vec_distance_cosine function
    const stmt = this.db.prepare(`
      SELECT
        v.memory_id as id,
        m.text,
        1 - vec_distance_cosine(v.embedding, ?) as similarity
      FROM memory_vectors v
      JOIN memories m ON v.memory_id = m.id
      ORDER BY vec_distance_cosine(v.embedding, ?)
      LIMIT ?
    `);

    const queryJson = JSON.stringify(queryEmbedding);
    const results = stmt.all(queryJson, queryJson, limit) as Array<{
      id: string;
      text: string;
      similarity: number;
    }>;

    return results.map((row) => ({
      id: row.id,
      text: row.text,
      similarity: row.similarity,
    }));
  }

  /**
   * Vector search using in-process cosine similarity fallback.
   */
  private vectorSearchCosineFallback(queryEmbedding: number[], limit: number): VectorSearchResult[] {
    // Fetch all embeddings and compute similarity in-process
    const stmt = this.db.prepare(`
      SELECT v.memory_id as id, m.text, v.embedding
      FROM memory_vectors v
      JOIN memories m ON v.memory_id = m.id
    `);

    const rows = stmt.all() as Array<{
      id: string;
      text: string;
      embedding: Buffer;
    }>;

    // Compute similarities
    const results: VectorSearchResult[] = rows.map((row) => {
      const embedding = this.bufferToFloatArray(row.embedding);
      const similarity = this.cosineSimilarity(queryEmbedding, embedding);
      return {
        id: row.id,
        text: row.text,
        similarity,
      };
    });

    // Sort by similarity descending and limit
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  /**
   * Convert Buffer to Float32 array.
   * Handles both binary Float32Array format and JSON-encoded arrays
   * for backward compatibility with different storage formats.
   */
  private bufferToFloatArray(buffer: Buffer): number[] {
    // Check if buffer is binary Float32Array format
    // Binary format: dimensions * 4 bytes (Float32 = 4 bytes each)
    if (buffer.byteLength === this.dimensions * 4) {
      const floatArray = new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength / 4
      );
      return Array.from(floatArray);
    }

    // Fallback: try parsing as JSON-encoded array
    // This handles embeddings stored via sqlite-vec (JSON format) or other sources
    try {
      const jsonStr = buffer.toString("utf8");
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed) && parsed.length === this.dimensions) {
        return parsed;
      }
      // Array exists but wrong dimension - return empty to trigger mismatch error
      console.warn(
        `[tram] Embedding dimension mismatch: expected ${this.dimensions}, got ${parsed.length}`
      );
      return [];
    } catch {
      // Neither binary nor valid JSON - return empty array
      console.warn(
        `[tram] Unable to parse embedding: not valid binary (${buffer.byteLength} bytes) ` +
        `or JSON format`
      );
      return [];
    }
  }

  /**
   * Compute cosine similarity between two vectors.
   * @param a - First vector
   * @param b - Second vector
   * @returns Cosine similarity (0 to 1)
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
      return 0;
    }

    // Clamp to [0, 1] range to handle floating point errors
    const similarity = dotProduct / (normA * normB);
    return Math.max(0, Math.min(1, similarity));
  }

  /**
   * Check if sqlite-vec extension is available.
   */
  isSqliteVecAvailable(): boolean {
    return this.sqliteVecAvailable;
  }

  /**
   * Get the number of stored embeddings.
   */
  getEmbeddingCount(): number {
    const result = this.db.prepare("SELECT COUNT(*) as count FROM memory_vectors").get() as { count: number };
    return result.count;
  }

  /**
   * Get an embedding by memory ID.
   * @param memoryId - The memory ID
   * @returns The embedding vector or null if not found
   */
  getEmbedding(memoryId: string): number[] | null {
    if (this.sqliteVecAvailable) {
      const stmt = this.db.prepare(`
        SELECT embedding FROM memory_vectors WHERE memory_id = ?
      `);
      const result = stmt.get(memoryId) as { embedding: string } | undefined;
      if (!result) return null;
      return JSON.parse(result.embedding);
    } else {
      const stmt = this.db.prepare(`
        SELECT embedding FROM memory_vectors WHERE memory_id = ?
      `);
      const result = stmt.get(memoryId) as { embedding: Buffer } | undefined;
      if (!result) return null;
      return this.bufferToFloatArray(result.embedding);
    }
  }
}

export default VectorHelper;
