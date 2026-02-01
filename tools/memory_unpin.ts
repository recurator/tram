/**
 * memory_unpin tool - Unpin memories to allow normal decay.
 * Sets pinned=false so the memory follows standard decay rules.
 */

import { randomUUID } from "node:crypto";
import type { Database as SqliteDb } from "better-sqlite3";
import { Tier, MemoryType, type Memory } from "../core/types.js";

/**
 * Input parameters for the memory_unpin tool
 */
export interface MemoryUnpinInput {
  /** Memory ID to unpin (required) */
  memoryId: string;
}

/**
 * Result from the memory_unpin tool
 */
export interface MemoryUnpinResult {
  /** Response content for the agent */
  content: Array<{ type: "text"; text: string }>;
  /** Details about the unpinned memory */
  details: {
    /** The memory ID */
    id: string;
    /** The memory text (truncated for display) */
    text: string;
    /** The memory tier */
    tier: Tier;
  };
}

/**
 * UUID regex pattern for validation
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * MemoryUnpinTool provides the memory_unpin tool implementation.
 * Unpins memories so they follow normal decay rules.
 */
export class MemoryUnpinTool {
  private db: SqliteDb;

  /**
   * Create a new MemoryUnpinTool instance.
   * @param db - The better-sqlite3 database instance
   */
  constructor(db: SqliteDb) {
    this.db = db;
  }

  /**
   * Unpin a memory.
   * @param input - The memory unpin parameters
   * @returns The result containing unpin confirmation
   */
  async execute(input: MemoryUnpinInput): Promise<MemoryUnpinResult> {
    // Validate required parameter
    if (!input.memoryId) {
      throw new Error("Missing required parameter: memoryId");
    }

    // Validate UUID format
    if (!UUID_REGEX.test(input.memoryId)) {
      throw new Error(
        `Invalid memory ID format: ${input.memoryId}. Expected UUID format.`
      );
    }

    // Fetch the memory
    const memory = this.fetchMemoryById(input.memoryId);

    if (!memory) {
      throw new Error(`Memory not found: ${input.memoryId}`);
    }

    // Check if memory is actually pinned
    if (!memory.pinned) {
      throw new Error(
        `Memory is not pinned: ${input.memoryId}. Only pinned memories can be unpinned.`
      );
    }

    // Unpin the memory
    const now = new Date().toISOString();
    this.unpinMemory(input.memoryId);

    // Create audit entry
    const oldValue = { pinned: true };
    const newValue = { pinned: false };
    this.createAuditEntry(
      input.memoryId,
      "unpin",
      JSON.stringify(oldValue),
      JSON.stringify(newValue),
      now
    );

    const truncatedText =
      memory.text.length > 100
        ? memory.text.substring(0, 100) + "..."
        : memory.text;

    return {
      content: [
        {
          type: "text",
          text: `Memory unpinned: "${truncatedText}". It will now follow normal decay rules.`,
        },
      ],
      details: {
        id: memory.id,
        text: truncatedText,
        tier: memory.tier,
      },
    };
  }

  /**
   * Fetch a memory by its ID.
   * @param id - The memory ID
   * @returns The memory or null if not found
   */
  private fetchMemoryById(id: string): Memory | null {
    const stmt = this.db.prepare(`
      SELECT
        id, text, importance, category, created_at, tier, memory_type,
        do_not_inject, pinned, use_count, last_accessed_at, use_days, source, parent_id
      FROM memories
      WHERE id = ?
    `);

    const row = stmt.get(id) as
      | {
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
        }
      | undefined;

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

  /**
   * Unpin a memory by setting pinned = 0.
   * @param id - The memory ID
   */
  private unpinMemory(id: string): void {
    const stmt = this.db.prepare(`
      UPDATE memories
      SET pinned = 0
      WHERE id = ?
    `);
    stmt.run(id);
  }

  /**
   * Create an audit log entry for the unpin action.
   * @param memoryId - The memory ID
   * @param action - The action type
   * @param oldValue - Previous value (JSON string or null)
   * @param newValue - New value (JSON string or null)
   * @param createdAt - Timestamp of the action
   */
  private createAuditEntry(
    memoryId: string,
    action: string,
    oldValue: string | null,
    newValue: string | null,
    createdAt: string
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO memory_audit (id, memory_id, action, old_value, new_value, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(randomUUID(), memoryId, action, oldValue, newValue, createdAt);
  }
}

export default MemoryUnpinTool;
