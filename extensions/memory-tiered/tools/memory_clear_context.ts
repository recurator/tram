/**
 * memory_clear_context tool - Clear the current active task context.
 */

import type { Database as SqliteDb } from "better-sqlite3";

/**
 * Result from the memory_clear_context tool
 */
export interface MemoryClearContextResult {
  /** Response content for the agent */
  content: Array<{ type: "text"; text: string }>;
  /** Details about the cleared context */
  details: {
    /** Whether a context was actually cleared */
    cleared: boolean;
    /** Previous context text if it existed */
    previousText?: string;
  };
}

/**
 * Active context ID
 */
const ACTIVE_CONTEXT_ID = "active";

/**
 * MemoryClearContextTool provides the memory_clear_context tool implementation.
 * Clears the current active task context.
 */
export class MemoryClearContextTool {
  private db: SqliteDb;

  /**
   * Create a new MemoryClearContextTool instance.
   * @param db - The better-sqlite3 database instance
   */
  constructor(db: SqliteDb) {
    this.db = db;
  }

  /**
   * Clear the current active task context.
   * @returns The result containing clear confirmation
   */
  async execute(): Promise<MemoryClearContextResult> {
    // Check if context exists before clearing
    const selectStmt = this.db.prepare(`
      SELECT text FROM current_context WHERE id = ?
    `);

    const row = selectStmt.get(ACTIVE_CONTEXT_ID) as {
      text: string;
    } | undefined;

    // Delete the context
    const deleteStmt = this.db.prepare(`
      DELETE FROM current_context WHERE id = ?
    `);
    const result = deleteStmt.run(ACTIVE_CONTEXT_ID);

    if (result.changes > 0) {
      return {
        content: [
          {
            type: "text",
            text: "Context cleared successfully.",
          },
        ],
        details: {
          cleared: true,
          previousText: row?.text,
        },
      };
    }

    return {
      content: [
        {
          type: "text",
          text: "No active context to clear.",
        },
      ],
      details: {
        cleared: false,
      },
    };
  }
}

export default MemoryClearContextTool;
