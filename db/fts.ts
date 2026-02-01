/**
 * FTS5 full-text search integration for the tiered memory system.
 * Provides full-text search on memory content with BM25 ranking.
 */

import type { Database as SqliteDb, Statement } from "better-sqlite3";

/**
 * Result from an FTS5 search including BM25 relevance score.
 */
export interface FTSSearchResult {
  /** Memory ID */
  id: string;
  /** Memory text content */
  text: string;
  /** BM25 relevance score (lower is more relevant, negated for sorting) */
  bm25Score: number;
}

/**
 * FTS5 helper class providing full-text search capabilities.
 * Creates and maintains the FTS5 virtual table and sync triggers.
 */
export class FTS5Helper {
  private db: SqliteDb;
  private searchStmt: Statement | null = null;

  /**
   * Create a new FTS5Helper instance.
   * @param db - The better-sqlite3 database instance
   */
  constructor(db: SqliteDb) {
    this.db = db;
    this.initialize();
  }

  /**
   * Initialize FTS5 virtual table and sync triggers.
   */
  private initialize(): void {
    // Create FTS5 virtual table for text column
    // Using content="" for external content table (contentless FTS)
    // with content_rowid pointing to memories table
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        text,
        content='memories',
        content_rowid='rowid'
      )
    `);

    // Create trigger to sync FTS on memory INSERT
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_fts_insert
      AFTER INSERT ON memories
      BEGIN
        INSERT INTO memories_fts(rowid, text)
        SELECT rowid, NEW.text FROM memories WHERE id = NEW.id;
      END
    `);

    // Create trigger to sync FTS on memory UPDATE
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_fts_update
      AFTER UPDATE OF text ON memories
      BEGIN
        DELETE FROM memories_fts WHERE rowid = (SELECT rowid FROM memories WHERE id = OLD.id);
        INSERT INTO memories_fts(rowid, text)
        SELECT rowid, NEW.text FROM memories WHERE id = NEW.id;
      END
    `);

    // Create trigger to sync FTS on memory DELETE
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_fts_delete
      AFTER DELETE ON memories
      BEGIN
        DELETE FROM memories_fts WHERE rowid = OLD.rowid;
      END
    `);
  }

  /**
   * Search memories using FTS5 with BM25 ranking.
   * @param query - The search query (FTS5 query syntax supported)
   * @param limit - Maximum number of results to return (default: 10)
   * @returns Array of search results ranked by BM25 score
   */
  searchFTS(query: string, limit: number = 10): FTSSearchResult[] {
    if (!query || query.trim() === "") {
      return [];
    }

    // Prepare statement once and cache it
    if (!this.searchStmt) {
      this.searchStmt = this.db.prepare(`
        SELECT
          m.id,
          m.text,
          bm25(memories_fts) as bm25_score
        FROM memories_fts fts
        JOIN memories m ON fts.rowid = (SELECT rowid FROM memories WHERE id = m.id)
        WHERE memories_fts MATCH ?
        ORDER BY bm25_score
        LIMIT ?
      `);
    }

    try {
      const results = this.searchStmt.all(query, limit) as Array<{
        id: string;
        text: string;
        bm25_score: number;
      }>;

      return results.map((row) => ({
        id: row.id,
        text: row.text,
        // BM25 returns negative scores where lower (more negative) is better
        // We negate it so higher scores mean more relevant
        bm25Score: -row.bm25_score,
      }));
    } catch (error) {
      // Handle FTS query syntax errors gracefully
      if (error instanceof Error && error.message.includes("fts5")) {
        // Try escaping the query as a phrase search
        const escapedQuery = `"${query.replace(/"/g, '""')}"`;
        try {
          const results = this.searchStmt.all(escapedQuery, limit) as Array<{
            id: string;
            text: string;
            bm25_score: number;
          }>;

          return results.map((row) => ({
            id: row.id,
            text: row.text,
            bm25Score: -row.bm25_score,
          }));
        } catch {
          // If still failing, return empty results
          return [];
        }
      }
      throw error;
    }
  }

  /**
   * Rebuild the FTS index from the memories table.
   * Useful after bulk imports or if index becomes corrupted.
   */
  rebuildIndex(): void {
    this.db.exec(`
      DELETE FROM memories_fts;
      INSERT INTO memories_fts(rowid, text)
      SELECT rowid, text FROM memories;
    `);
  }

  /**
   * Get the total number of indexed documents.
   */
  getIndexedCount(): number {
    const result = this.db.prepare("SELECT COUNT(*) as count FROM memories_fts").get() as { count: number };
    return result.count;
  }
}

export default FTS5Helper;
