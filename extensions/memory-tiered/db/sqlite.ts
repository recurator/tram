/**
 * SQLite database wrapper with schema initialization for tiered memory system.
 * Uses better-sqlite3 for synchronous operations with WAL mode for concurrency.
 */

import BetterSqlite3 from "better-sqlite3";
import type { Database as SqliteDb } from "better-sqlite3";
import { Tier, type Memory, type CurrentContext, type MemoryAudit } from "../core/types.js";

/**
 * Database wrapper class providing schema initialization and basic operations.
 */
export class Database {
  private db: SqliteDb;

  /**
   * Create a new Database instance.
   * @param dbPath - Path to the SQLite database file
   */
  constructor(dbPath: string) {
    this.db = new BetterSqlite3(dbPath);
    this.initialize();
  }

  /**
   * Initialize database schema, WAL mode, and indexes.
   */
  private initialize(): void {
    // Enable WAL mode for better concurrency
    this.db.pragma("journal_mode = WAL");

    // Create memories table with all required columns
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        category TEXT,
        created_at TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'HOT' CHECK (tier IN ('HOT', 'WARM', 'COLD', 'ARCHIVE')),
        memory_type TEXT NOT NULL DEFAULT 'factual',
        do_not_inject INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT NOT NULL,
        use_days TEXT NOT NULL DEFAULT '[]',
        source TEXT,
        parent_id TEXT,
        entity_refs TEXT,
        meta_type TEXT,
        FOREIGN KEY (parent_id) REFERENCES memories(id) ON DELETE SET NULL
      )
    `);

    // Create indexes for common query patterns
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
      CREATE INDEX IF NOT EXISTS idx_memories_do_not_inject ON memories(do_not_inject);
      CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned);
      CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed_at);
    `);

    // Create current_context table for active task context
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS current_context (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ttl_seconds INTEGER NOT NULL DEFAULT 14400
      )
    `);

    // Create memory_audit table for tracking state changes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_audit (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        action TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      )
    `);
  }

  /**
   * Get the underlying better-sqlite3 database instance.
   */
  getDb(): SqliteDb {
    return this.db;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  /**
   * Check if the database is open.
   */
  isOpen(): boolean {
    return this.db.open;
  }
}

export default Database;
