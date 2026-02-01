/**
 * memory_pin tool - Pin important memories to bypass decay.
 * Sets pinned=true and defaults tier to WARM if not already set.
 */

import { randomUUID } from "node:crypto";
import type { Database as SqliteDb } from "better-sqlite3";
import { Tier, MemoryType, type Memory } from "../core/types.js";

/**
 * Input parameters for the memory_pin tool
 */
export interface MemoryPinInput {
  /** Memory ID to pin (required) */
  memoryId: string;
}

/**
 * Result from the memory_pin tool
 */
export interface MemoryPinResult {
  /** Response content for the agent */
  content: Array<{ type: "text"; text: string }>;
  /** Details about the pinned memory */
  details: {
    /** The memory ID */
    id: string;
    /** The memory text (truncated for display) */
    text: string;
    /** The memory tier */
    tier: Tier;
    /** Whether the tier was updated */
    tierUpdated: boolean;
  };
}

/**
 * UUID regex pattern for validation
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * MemoryPinTool provides the memory_pin tool implementation.
 * Pins memories to bypass decay and prioritize them for injection.
 */
export class MemoryPinTool {
  private db: SqliteDb;

  /**
   * Create a new MemoryPinTool instance.
   * @param db - The better-sqlite3 database instance
   */
  constructor(db: SqliteDb) {
    this.db = db;
  }

  /**
   * Pin a memory.
   * @param input - The memory pin parameters
   * @returns The result containing pin confirmation
   */
  async execute(input: MemoryPinInput): Promise<MemoryPinResult> {
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

    // Check if memory is already pinned
    if (memory.pinned) {
      throw new Error(
        `Memory is already pinned: ${input.memoryId}. No action needed.`
      );
    }

    // Determine if tier needs update (default to WARM if not set or if COLD/ARCHIVE)
    const shouldUpdateTier =
      memory.tier === Tier.COLD || memory.tier === Tier.ARCHIVE;
    const newTier = shouldUpdateTier ? Tier.WARM : memory.tier;

    // Pin the memory and optionally update tier
    const now = new Date().toISOString();
    this.pinMemory(input.memoryId, newTier, shouldUpdateTier);

    // Create audit entry
    const oldValue = { pinned: false, tier: memory.tier };
    const newValue = { pinned: true, tier: newTier };
    this.createAuditEntry(
      input.memoryId,
      "pin",
      JSON.stringify(oldValue),
      JSON.stringify(newValue),
      now
    );

    const truncatedText =
      memory.text.length > 100
        ? memory.text.substring(0, 100) + "..."
        : memory.text;

    let message = `Memory pinned: "${truncatedText}". It will now bypass decay and receive priority injection.`;
    if (shouldUpdateTier) {
      message += ` Tier updated from ${memory.tier} to ${newTier}.`;
    }

    return {
      content: [
        {
          type: "text",
          text: message,
        },
      ],
      details: {
        id: memory.id,
        text: truncatedText,
        tier: newTier,
        tierUpdated: shouldUpdateTier,
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
   * Pin a memory by setting pinned = 1 and optionally updating tier.
   * @param id - The memory ID
   * @param newTier - The new tier value
   * @param updateTier - Whether to update the tier
   */
  private pinMemory(id: string, newTier: Tier, updateTier: boolean): void {
    if (updateTier) {
      const stmt = this.db.prepare(`
        UPDATE memories
        SET pinned = 1, tier = ?
        WHERE id = ?
      `);
      stmt.run(newTier, id);
    } else {
      const stmt = this.db.prepare(`
        UPDATE memories
        SET pinned = 1
        WHERE id = ?
      `);
      stmt.run(id);
    }
  }

  /**
   * Create an audit log entry for the pin action.
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

export default MemoryPinTool;
