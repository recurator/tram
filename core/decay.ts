/**
 * DecayEngine - Background decay service for automatic tier demotion.
 *
 * Rules:
 *   - HOT memories past 72 hours → COLD
 *   - WARM memories unused > 60 days → COLD
 *   - Pinned memories never decay
 *   - Creates audit log entries for all demotions
 *   - Stores last_decay_run timestamp in DB meta table
 */

import { randomUUID } from "node:crypto";
import type { Database as SqliteDb } from "better-sqlite3";
import { Tier, type Memory, MemoryType } from "./types.js";
import type { ResolvedConfig } from "../config.js";

/**
 * Result from running the decay engine
 */
export interface DecayResult {
  /** Number of HOT memories demoted to COLD */
  hotDemoted: number;
  /** Number of WARM memories demoted to COLD */
  warmDemoted: number;
  /** Total memories processed (checked for decay) */
  totalProcessed: number;
  /** Timestamp when decay was run */
  runAt: string;
}

/**
 * Memory row from database for decay checks
 */
interface MemoryRow {
  id: string;
  tier: string;
  pinned: number;
  created_at: string;
  last_accessed_at: string;
}

/**
 * DecayEngine handles automatic tier demotion based on time and usage.
 */
export class DecayEngine {
  private db: SqliteDb;
  private hotTtlHours: number;
  private warmDemotionDays: number;

  /**
   * Create a new DecayEngine instance.
   * @param db - The better-sqlite3 database instance
   * @param config - Resolved plugin configuration (optional, uses defaults)
   */
  constructor(db: SqliteDb, config?: Partial<ResolvedConfig>) {
    this.db = db;
    // Default: 72 hours for HOT TTL
    this.hotTtlHours = config?.tiers?.hot?.ttlHours ?? 72;
    // Default: 60 days for WARM demotion
    this.warmDemotionDays = config?.tiers?.warm?.demotionDays ?? 60;

    // Ensure meta table exists for storing last_decay_run
    this.ensureMetaTable();
  }

  /**
   * Run the decay engine to demote stale memories.
   * @returns Result containing counts of demoted memories
   */
  run(): DecayResult {
    const now = new Date();
    const nowIso = now.toISOString();

    let hotDemoted = 0;
    let warmDemoted = 0;
    let totalProcessed = 0;

    // Process HOT tier demotions
    const hotMemories = this.fetchMemoriesByTier(Tier.HOT);
    for (const memory of hotMemories) {
      totalProcessed++;
      if (this.shouldDemoteHot(memory, now)) {
        this.demoteMemory(memory.id, Tier.HOT, Tier.COLD, nowIso);
        hotDemoted++;
      }
    }

    // Process WARM tier demotions
    const warmMemories = this.fetchMemoriesByTier(Tier.WARM);
    for (const memory of warmMemories) {
      totalProcessed++;
      if (this.shouldDemoteWarm(memory, now)) {
        this.demoteMemory(memory.id, Tier.WARM, Tier.COLD, nowIso);
        warmDemoted++;
      }
    }

    // Store last decay run timestamp
    this.setLastDecayRun(nowIso);

    return {
      hotDemoted,
      warmDemoted,
      totalProcessed,
      runAt: nowIso,
    };
  }

  /**
   * Get the timestamp of the last decay run.
   * @returns ISO 8601 timestamp or null if never run
   */
  getLastDecayRun(): string | null {
    try {
      const stmt = this.db.prepare(`
        SELECT value FROM meta WHERE key = ?
      `);
      const row = stmt.get("last_decay_run") as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      // Meta table might not exist in legacy databases
      return null;
    }
  }

  /**
   * Check if enough time has passed since last decay run.
   * @param intervalHours - Minimum hours between runs
   * @returns True if decay should run, false otherwise
   */
  shouldRun(intervalHours: number): boolean {
    const lastRun = this.getLastDecayRun();
    if (!lastRun) {
      return true;
    }

    const lastRunTime = new Date(lastRun).getTime();
    const now = Date.now();
    const intervalMs = intervalHours * 60 * 60 * 1000;

    return now - lastRunTime >= intervalMs;
  }

  /**
   * Ensure the meta table exists for storing decay run timestamps.
   */
  private ensureMetaTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  /**
   * Fetch all memories in a specific tier that are not pinned.
   * @param tier - The tier to fetch
   * @returns Array of memory rows
   */
  private fetchMemoriesByTier(tier: Tier): MemoryRow[] {
    const stmt = this.db.prepare(`
      SELECT id, tier, pinned, created_at, last_accessed_at
      FROM memories
      WHERE tier = ? AND pinned = 0
    `);
    return stmt.all(tier) as MemoryRow[];
  }

  /**
   * Check if a HOT memory should be demoted.
   * Rule: HOT memories past hotTtlHours (default 72) → COLD
   * @param memory - The memory row
   * @param now - Current time
   * @returns True if should demote
   */
  private shouldDemoteHot(memory: MemoryRow, now: Date): boolean {
    const createdAt = new Date(memory.created_at);
    const ageHours = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
    return ageHours > this.hotTtlHours;
  }

  /**
   * Check if a WARM memory should be demoted.
   * Rule: WARM memories unused > warmDemotionDays (default 60) → COLD
   * @param memory - The memory row
   * @param now - Current time
   * @returns True if should demote
   */
  private shouldDemoteWarm(memory: MemoryRow, now: Date): boolean {
    const lastAccessedAt = new Date(memory.last_accessed_at);
    const inactiveDays =
      (now.getTime() - lastAccessedAt.getTime()) / (1000 * 60 * 60 * 24);
    return inactiveDays > this.warmDemotionDays;
  }

  /**
   * Demote a memory to a lower tier and create audit entry.
   * @param memoryId - The memory ID
   * @param fromTier - Original tier
   * @param toTier - Target tier
   * @param timestamp - ISO timestamp for the demotion
   */
  private demoteMemory(
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
      "demote",
      JSON.stringify({ tier: fromTier }),
      JSON.stringify({ tier: toTier }),
      timestamp
    );
  }

  /**
   * Store the last decay run timestamp in the meta table.
   * @param timestamp - ISO 8601 timestamp
   */
  private setLastDecayRun(timestamp: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO meta (key, value, updated_at)
      VALUES (?, ?, ?)
    `);
    stmt.run("last_decay_run", timestamp, timestamp);
  }

  /**
   * Create an audit log entry for a demotion action.
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

export default DecayEngine;
