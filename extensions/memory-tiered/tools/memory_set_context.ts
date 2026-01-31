/**
 * memory_set_context tool - Set the current active task context.
 * Context is used for automatic recall and has a configurable TTL.
 */

import type { Database as SqliteDb } from "better-sqlite3";
import type { CurrentContext } from "../core/types.js";

/**
 * Input parameters for the memory_set_context tool
 */
export interface MemorySetContextInput {
  /** The context text (required) */
  text: string;
  /** Time-to-live in hours (default: 4) */
  ttlHours?: number;
}

/**
 * Result from the memory_set_context tool
 */
export interface MemorySetContextResult {
  /** Response content for the agent */
  content: Array<{ type: "text"; text: string }>;
  /** Details about the context */
  details: {
    /** Context ID (always 'active') */
    id: string;
    /** The context text */
    text: string;
    /** When the context was created (ISO 8601) */
    created_at: string;
    /** TTL in seconds */
    ttl_seconds: number;
    /** When the context will expire (ISO 8601) */
    expires_at: string;
  };
}

/**
 * Default TTL in hours
 */
const DEFAULT_TTL_HOURS = 4;

/**
 * Active context ID
 */
const ACTIVE_CONTEXT_ID = "active";

/**
 * MemorySetContextTool provides the memory_set_context tool implementation.
 * Sets or updates the current active task context with TTL.
 */
export class MemorySetContextTool {
  private db: SqliteDb;

  /**
   * Create a new MemorySetContextTool instance.
   * @param db - The better-sqlite3 database instance
   */
  constructor(db: SqliteDb) {
    this.db = db;
  }

  /**
   * Set the current active task context.
   * @param input - The context input parameters
   * @returns The result containing context details
   */
  async execute(input: MemorySetContextInput): Promise<MemorySetContextResult> {
    // Validate required input
    if (!input.text || typeof input.text !== "string") {
      throw new Error("Missing required parameter: text");
    }

    const text = input.text.trim();
    if (text.length === 0) {
      throw new Error("Context text cannot be empty");
    }

    // Calculate TTL in seconds
    const ttlHours = input.ttlHours ?? DEFAULT_TTL_HOURS;
    if (ttlHours <= 0) {
      throw new Error("TTL hours must be greater than 0");
    }
    const ttlSeconds = Math.floor(ttlHours * 3600);

    // Get current timestamp
    const now = new Date();
    const createdAt = now.toISOString();

    // Calculate expiry timestamp
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    // Upsert the context (INSERT OR REPLACE)
    const upsertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO current_context (id, text, created_at, ttl_seconds)
      VALUES (?, ?, ?, ?)
    `);

    upsertStmt.run(ACTIVE_CONTEXT_ID, text, createdAt, ttlSeconds);

    return {
      content: [
        {
          type: "text",
          text: `Context set successfully. Expires at ${expiresAt}.`,
        },
      ],
      details: {
        id: ACTIVE_CONTEXT_ID,
        text,
        created_at: createdAt,
        ttl_seconds: ttlSeconds,
        expires_at: expiresAt,
      },
    };
  }

  /**
   * Get the current context if not expired.
   * Implements lazy TTL expiry check.
   * @returns The current context or null if none/expired
   */
  getContext(): CurrentContext | null {
    const stmt = this.db.prepare(`
      SELECT id, text, created_at, ttl_seconds
      FROM current_context
      WHERE id = ?
    `);

    const row = stmt.get(ACTIVE_CONTEXT_ID) as {
      id: string;
      text: string;
      created_at: string;
      ttl_seconds: number;
    } | undefined;

    if (!row) {
      return null;
    }

    // Check if context has expired (lazy TTL check)
    const createdAt = new Date(row.created_at);
    const expiresAt = new Date(createdAt.getTime() + row.ttl_seconds * 1000);
    const now = new Date();

    if (now > expiresAt) {
      // Context has expired, clean it up
      this.deleteContext();
      return null;
    }

    return {
      id: row.id,
      text: row.text,
      created_at: row.created_at,
      ttl_seconds: row.ttl_seconds,
    };
  }

  /**
   * Delete the active context.
   */
  private deleteContext(): void {
    const stmt = this.db.prepare(`
      DELETE FROM current_context WHERE id = ?
    `);
    stmt.run(ACTIVE_CONTEXT_ID);
  }
}

export default MemorySetContextTool;
