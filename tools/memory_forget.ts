/**
 * memory_forget tool - Forget memories without permanent deletion.
 * Supports soft forget (do_not_inject = true) and hard delete.
 */

import { randomUUID } from "node:crypto";
import type { Database as SqliteDb } from "better-sqlite3";
import { Tier, MemoryType, type Memory } from "../core/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { VectorHelper } from "../db/vectors.js";

/**
 * Input parameters for the memory_forget tool
 */
export interface MemoryForgetInput {
  /** Specific memory ID to forget */
  memoryId?: string;
  /** Search query to find memory to forget */
  query?: string;
  /** If true, permanently delete instead of soft forget (default: false) */
  hard?: boolean;
}

/**
 * Result from the memory_forget tool
 */
export interface MemoryForgetResult {
  /** Response content for the agent */
  content: Array<{ type: "text"; text: string }>;
  /** Details about the forgotten memory */
  details: {
    /** The memory ID */
    id: string;
    /** The memory text (truncated for display) */
    text: string;
    /** Whether it was a hard delete */
    hardDeleted: boolean;
    /** Whether the memory can be restored (false if hard deleted) */
    restorable: boolean;
  };
}

/**
 * UUID regex pattern for validation
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * MemoryForgetTool provides the memory_forget tool implementation.
 * Supports soft forget (reversible) and hard delete (permanent).
 */
export class MemoryForgetTool {
  private db: SqliteDb;
  private embeddingProvider: EmbeddingProvider;
  private vectorHelper: VectorHelper;

  /**
   * Create a new MemoryForgetTool instance.
   * @param db - The better-sqlite3 database instance
   * @param embeddingProvider - Provider for generating embeddings
   * @param vectorHelper - Helper for vector storage and search
   */
  constructor(
    db: SqliteDb,
    embeddingProvider: EmbeddingProvider,
    vectorHelper: VectorHelper
  ) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    this.vectorHelper = vectorHelper;
  }

  /**
   * Forget a memory (soft forget or hard delete).
   * @param input - The memory forget parameters
   * @returns The result containing forget confirmation
   */
  async execute(input: MemoryForgetInput): Promise<MemoryForgetResult> {
    // Validate that at least one of memoryId or query is provided
    if (!input.memoryId && !input.query) {
      throw new Error(
        "Missing required parameter: either memoryId or query must be provided"
      );
    }

    const hard = input.hard ?? false;

    // Find the memory to forget
    let memory: Memory | null = null;

    if (input.memoryId) {
      // Validate UUID format
      if (!UUID_REGEX.test(input.memoryId)) {
        throw new Error(
          `Invalid memory ID format: ${input.memoryId}. Expected UUID format.`
        );
      }
      memory = this.fetchMemoryById(input.memoryId);
    } else if (input.query) {
      memory = await this.findMemoryByQuery(input.query.trim());
    }

    if (!memory) {
      throw new Error(
        input.memoryId
          ? `Memory not found: ${input.memoryId}`
          : `No memory found matching query: "${input.query}"`
      );
    }

    // Check if already forgotten (soft delete)
    if (!hard && memory.do_not_inject) {
      throw new Error(
        `Memory is already forgotten: ${memory.id}. Use hard=true for permanent deletion.`
      );
    }

    const now = new Date().toISOString();
    const truncatedText =
      memory.text.length > 100
        ? memory.text.substring(0, 100) + "..."
        : memory.text;

    if (hard) {
      // Hard delete: remove from database permanently
      this.hardDeleteMemory(memory.id);
      this.createAuditEntry(memory.id, "forget", "hard_delete", null, now);

      return {
        content: [
          {
            type: "text",
            text: `Memory permanently deleted: "${truncatedText}"`,
          },
        ],
        details: {
          id: memory.id,
          text: truncatedText,
          hardDeleted: true,
          restorable: false,
        },
      };
    } else {
      // Soft forget: set do_not_inject = true
      this.softForgetMemory(memory.id);
      this.createAuditEntry(
        memory.id,
        "forget",
        JSON.stringify({ do_not_inject: false }),
        JSON.stringify({ do_not_inject: true }),
        now
      );

      return {
        content: [
          {
            type: "text",
            text: `Memory forgotten: "${truncatedText}". It can be restored with memory_restore.`,
          },
        ],
        details: {
          id: memory.id,
          text: truncatedText,
          hardDeleted: false,
          restorable: true,
        },
      };
    }
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
   * Find a memory by search query (returns best match).
   * @param query - The search query
   * @returns The best matching memory or null
   */
  private async findMemoryByQuery(query: string): Promise<Memory | null> {
    if (query.length === 0) {
      return null;
    }

    // Generate embedding for the query
    const queryEmbedding = await this.embeddingProvider.embed(query);

    // Search for matching memories
    const results = this.vectorHelper.hybridSearch(query, queryEmbedding, {
      limit: 1,
    });

    if (results.length === 0) {
      return null;
    }

    return this.fetchMemoryById(results[0].id);
  }

  /**
   * Soft forget a memory by setting do_not_inject = true.
   * @param id - The memory ID
   */
  private softForgetMemory(id: string): void {
    const stmt = this.db.prepare(`
      UPDATE memories
      SET do_not_inject = 1
      WHERE id = ?
    `);
    stmt.run(id);
  }

  /**
   * Hard delete a memory from the database.
   * @param id - The memory ID
   */
  private hardDeleteMemory(id: string): void {
    // Delete from memories table (triggers will handle FTS cleanup)
    const stmt = this.db.prepare(`
      DELETE FROM memories
      WHERE id = ?
    `);
    stmt.run(id);

    // Also delete from vector table if it exists
    try {
      this.vectorHelper.deleteEmbedding(id);
    } catch {
      // Ignore errors if vector table doesn't exist or other issues
    }
  }

  /**
   * Create an audit log entry for the forget action.
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

export default MemoryForgetTool;
