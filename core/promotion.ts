/**
 * PromotionEngine - Promotes frequently-used COLD memories to WARM tier.
 *
 * Rules:
 *   - COLD memories with >=promotionUses (default 3) uses AND
 *     >=promotionDays (default 2) distinct days → promote to WARM
 *   - Never auto-promote to HOT (only user/system can set HOT)
 *   - Pinned memories are skipped (already have priority)
 *   - Creates audit log entries for all promotions
 */

import { randomUUID } from "node:crypto";
import type { Database as SqliteDb } from "better-sqlite3";
import { Tier } from "./types.js";
import type { ResolvedConfig } from "../config.js";

/**
 * Result from running the promotion engine
 */
export interface PromotionResult {
  /** Number of COLD memories promoted to WARM */
  promoted: number;
  /** Total COLD memories checked */
  totalProcessed: number;
  /** Timestamp when promotion was run */
  runAt: string;
}

/**
 * Memory row from database for promotion checks
 */
interface MemoryRow {
  id: string;
  tier: string;
  pinned: number;
  use_count: number;
  use_days: string; // JSON array of dates
}

/**
 * PromotionEngine handles automatic tier promotion based on usage patterns.
 */
export class PromotionEngine {
  private db: SqliteDb;
  private promotionUses: number;
  private promotionDays: number;

  /**
   * Create a new PromotionEngine instance.
   * @param db - The better-sqlite3 database instance
   * @param config - Resolved plugin configuration (optional, uses defaults)
   */
  constructor(db: SqliteDb, config?: Partial<ResolvedConfig>) {
    this.db = db;
    // Default: 3 uses for promotion
    this.promotionUses = config?.tiers?.cold?.promotionUses ?? 3;
    // Default: 2 distinct days for promotion
    this.promotionDays = config?.tiers?.cold?.promotionDays ?? 2;
  }

  /**
   * Run the promotion engine to promote qualifying COLD memories.
   * @returns Result containing count of promoted memories
   */
  run(): PromotionResult {
    const now = new Date();
    const nowIso = now.toISOString();

    let promoted = 0;
    let totalProcessed = 0;

    // Process COLD tier promotions
    const coldMemories = this.fetchColdMemories();
    for (const memory of coldMemories) {
      totalProcessed++;
      if (this.shouldPromote(memory)) {
        this.promoteMemory(memory.id, Tier.COLD, Tier.WARM, nowIso);
        promoted++;
      }
    }

    return {
      promoted,
      totalProcessed,
      runAt: nowIso,
    };
  }

  /**
   * Fetch all COLD memories that are not pinned.
   * @returns Array of memory rows
   */
  private fetchColdMemories(): MemoryRow[] {
    const stmt = this.db.prepare(`
      SELECT id, tier, pinned, use_count, use_days
      FROM memories
      WHERE tier = ? AND pinned = 0
    `);
    return stmt.all(Tier.COLD) as MemoryRow[];
  }

  /**
   * Check if a COLD memory should be promoted to WARM.
   * Rule: >=promotionUses AND >=promotionDays distinct days
   * @param memory - The memory row
   * @returns True if should promote
   */
  private shouldPromote(memory: MemoryRow): boolean {
    // Check use count threshold
    if (memory.use_count < this.promotionUses) {
      return false;
    }

    // Parse use_days JSON array and count distinct days
    let useDays: string[];
    try {
      useDays = JSON.parse(memory.use_days || "[]");
    } catch {
      useDays = [];
    }

    // Check distinct days threshold
    const distinctDays = new Set(useDays).size;
    return distinctDays >= this.promotionDays;
  }

  /**
   * Promote a memory to a higher tier and create audit entry.
   * @param memoryId - The memory ID
   * @param fromTier - Original tier
   * @param toTier - Target tier
   * @param timestamp - ISO timestamp for the promotion
   */
  private promoteMemory(
    memoryId: string,
    fromTier: Tier,
    toTier: Tier,
    timestamp: string
  ): void {
    // Update the tier
    const updateStmt = this.db.prepare(`
      UPDATE memories
      SET tier = ?
      WHERE id = ?
    `);
    updateStmt.run(toTier, memoryId);

    // Create audit entry
    this.createAuditEntry(
      memoryId,
      "promote",
      JSON.stringify({ tier: fromTier }),
      JSON.stringify({ tier: toTier }),
      timestamp
    );
  }

  /**
   * Create an audit log entry for a promotion action.
   * @param memoryId - The memory ID
   * @param action - The action type
   * @param oldValue - Previous value (JSON string)
   * @param newValue - New value (JSON string)
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

export default PromotionEngine;
