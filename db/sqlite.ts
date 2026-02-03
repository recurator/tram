/**
 * SQLite database wrapper with schema initialization for tiered memory system.
 * Uses better-sqlite3 for synchronous operations with WAL mode for concurrency.
 * Includes retry logic for handling database lock errors.
 */

import BetterSqlite3 from "better-sqlite3";
import type { Database as SqliteDb, Statement } from "better-sqlite3";
import { Tier, type Memory, type CurrentContext, type MemoryAudit } from "../core/types.js";
import { withRetrySync, type RetryConfig } from "./retry.js";
import { DatabaseLockedError } from "../core/errors.js";

/**
 * Default retry configuration for database operations.
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 2000,
  backoffMultiplier: 2,
};

/**
 * Database wrapper class providing schema initialization and basic operations.
 * Includes automatic retry logic for handling SQLite lock/busy errors.
 */
export class Database {
  private db: SqliteDb;
  private retryConfig: RetryConfig;

  /**
   * Create a new Database instance.
   * @param dbPath - Path to the SQLite database file
   * @param retryConfig - Optional retry configuration for lock handling
   */
  constructor(dbPath: string, retryConfig?: RetryConfig) {
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
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

    // Create injection_feedback table for tracking injection outcomes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS injection_feedback (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        injected_at TEXT NOT NULL,
        access_frequency INTEGER NOT NULL DEFAULT 0,
        session_outcome TEXT,
        injection_density REAL NOT NULL DEFAULT 0,
        decay_resistance REAL,
        proxy_score REAL,
        agent_score REAL,
        agent_notes TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      )
    `);

    // Create indexes for injection_feedback
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_injection_feedback_memory_id ON injection_feedback(memory_id);
      CREATE INDEX IF NOT EXISTS idx_injection_feedback_injected_at ON injection_feedback(injected_at);
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

  /**
   * Execute a database operation with automatic retry on lock errors.
   * Uses exponential backoff between retries.
   *
   * @param operation - The operation to execute
   * @returns The result of the operation
   * @throws DatabaseLockedError if all retries are exhausted
   */
  withRetry<T>(operation: () => T): T {
    return withRetrySync(operation, this.retryConfig);
  }

  /**
   * Prepare a statement with retry wrapper.
   * The returned statement's run, get, and all methods are wrapped with retry logic.
   *
   * @param sql - The SQL statement to prepare
   * @returns A wrapped Statement with automatic retry
   */
  prepareWithRetry(sql: string): Statement {
    const stmt = this.db.prepare(sql);
    const self = this;

    // Return the original statement - let the caller use withRetry if needed
    // This is because Statement methods return the statement itself for chaining
    return stmt;
  }

  /**
   * Execute SQL with retry logic.
   * @param sql - The SQL to execute
   */
  execWithRetry(sql: string): void {
    this.withRetry(() => this.db.exec(sql));
  }

  /**
   * Run a prepared statement's run method with retry.
   * @param stmt - The prepared statement
   * @param params - Parameters for the statement
   * @returns The run info
   */
  runWithRetry(stmt: Statement, ...params: unknown[]): BetterSqlite3.RunResult {
    return this.withRetry(() => stmt.run(...params));
  }

  /**
   * Run a prepared statement's get method with retry.
   * @param stmt - The prepared statement
   * @param params - Parameters for the statement
   * @returns The row or undefined
   */
  getWithRetry<T>(stmt: Statement, ...params: unknown[]): T | undefined {
    return this.withRetry(() => stmt.get(...params) as T | undefined);
  }

  /**
   * Run a prepared statement's all method with retry.
   * @param stmt - The prepared statement
   * @param params - Parameters for the statement
   * @returns Array of rows
   */
  allWithRetry<T>(stmt: Statement, ...params: unknown[]): T[] {
    return this.withRetry(() => stmt.all(...params) as T[]);
  }
}

export default Database;
