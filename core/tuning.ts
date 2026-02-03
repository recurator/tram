/**
 * TuningEngine - Auto-adjustment of memory tier parameters.
 *
 * Rules:
 *   - Checks tier sizes during decay run (piggyback on existing cron)
 *   - If HOT > hotTargetSize.max, increase importanceThreshold by step
 *   - If HOT < hotTargetSize.min, decrease importanceThreshold by step
 *   - Respects tuning.autoAdjust bounds (never exceed min/max)
 *   - Only adjusts when tuning.mode is 'auto' or 'hybrid'
 *   - Skips locked parameters (user_override_until in tuning_log)
 *   - Logs all changes to tuning_log table
 */

import { randomUUID } from "node:crypto";
import type { Database as SqliteDb } from "better-sqlite3";
import { Tier } from "./types.js";
import type { ResolvedConfig, TuningModeValue } from "../config.js";

/**
 * Result from running the tuning engine
 */
export interface TuningResult {
  /** Whether any adjustments were made */
  adjusted: boolean;
  /** Details of adjustments made */
  adjustments: TuningAdjustment[];
  /** Timestamp when tuning was run */
  runAt: string;
}

/**
 * A single parameter adjustment
 */
export interface TuningAdjustment {
  /** Name of the parameter adjusted */
  parameter: string;
  /** Previous value */
  oldValue: number;
  /** New value after adjustment */
  newValue: number;
  /** Human-readable reason for adjustment */
  reason: string;
}

/**
 * Tier counts from database
 */
export interface TierCounts {
  hot: number;
  warm: number;
  cold: number;
  archive: number;
  total: number;
}

/**
 * TuningEngine handles automatic parameter adjustment based on tier sizes.
 */
export class TuningEngine {
  private db: SqliteDb;
  private config: ResolvedConfig;

  /**
   * Create a new TuningEngine instance.
   * @param db - The better-sqlite3 database instance
   * @param config - Resolved plugin configuration
   */
  constructor(db: SqliteDb, config: ResolvedConfig) {
    this.db = db;
    this.config = config;
  }

  /**
   * Run the tuning engine to check and adjust parameters.
   * @returns Result containing adjustment details
   */
  run(): TuningResult {
    const now = new Date();
    const nowIso = now.toISOString();
    const adjustments: TuningAdjustment[] = [];

    // Skip if tuning is disabled
    if (!this.config.tuning.enabled) {
      return { adjusted: false, adjustments: [], runAt: nowIso };
    }

    // Skip if mode is manual (user-only adjustments)
    if (this.config.tuning.mode === "manual") {
      return { adjusted: false, adjustments: [], runAt: nowIso };
    }

    // Get current tier counts
    const tierCounts = this.getTierCounts();

    // Get current importanceThreshold value
    const currentThreshold = this.getCurrentImportanceThreshold();
    const bounds = this.config.tuning.autoAdjust.importanceThreshold;
    const hotTarget = this.config.tuning.autoAdjust.hotTargetSize;

    // Check if importanceThreshold is locked
    if (this.isParameterLocked("importanceThreshold")) {
      return { adjusted: false, adjustments: [], runAt: nowIso };
    }

    // Adjust importanceThreshold based on HOT tier size
    let newThreshold = currentThreshold;
    let reason: string | null = null;

    if (tierCounts.hot > hotTarget.max) {
      // HOT tier too large - increase threshold to demote more memories
      newThreshold = Math.min(currentThreshold + bounds.step, bounds.max);
      reason = `HOT tier exceeded target (${tierCounts.hot} > ${hotTarget.max})`;
    } else if (tierCounts.hot < hotTarget.min) {
      // HOT tier too small - decrease threshold to keep more memories
      newThreshold = Math.max(currentThreshold - bounds.step, bounds.min);
      reason = `HOT tier below target (${tierCounts.hot} < ${hotTarget.min})`;
    }

    // Only log if there was an actual change
    if (newThreshold !== currentThreshold && reason) {
      // Log the tuning change
      this.logTuningChange(
        "importanceThreshold",
        currentThreshold,
        newThreshold,
        reason,
        "auto",
        nowIso
      );

      adjustments.push({
        parameter: "importanceThreshold",
        oldValue: currentThreshold,
        newValue: newThreshold,
        reason,
      });
    }

    return {
      adjusted: adjustments.length > 0,
      adjustments,
      runAt: nowIso,
    };
  }

  /**
   * Get current tier counts from the database.
   * @returns Tier counts object
   */
  getTierCounts(): TierCounts {
    const stmt = this.db.prepare(`
      SELECT tier, COUNT(*) as count
      FROM memories
      WHERE do_not_inject = 0
      GROUP BY tier
    `);
    const rows = stmt.all() as Array<{ tier: string; count: number }>;

    const countMap = new Map(rows.map((r) => [r.tier, r.count]));

    const hot = countMap.get(Tier.HOT) ?? 0;
    const warm = countMap.get(Tier.WARM) ?? 0;
    const cold = countMap.get(Tier.COLD) ?? 0;
    const archive = countMap.get(Tier.ARCHIVE) ?? 0;

    return {
      hot,
      warm,
      cold,
      archive,
      total: hot + warm + cold + archive,
    };
  }

  /**
   * Get the current importanceThreshold value.
   * This retrieves from the most recent tuning_log entry, or uses the default.
   * @returns Current importance threshold value
   */
  getCurrentImportanceThreshold(): number {
    const stmt = this.db.prepare(`
      SELECT new_value
      FROM tuning_log
      WHERE parameter = 'importanceThreshold'
        AND reverted = 0
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    const row = stmt.get() as { new_value: string } | undefined;

    if (row) {
      return JSON.parse(row.new_value);
    }

    // Return default value from config if no tuning has occurred
    // The initial value is the midpoint of the bounds
    return this.config.injection.minScore;
  }

  /**
   * Check if a parameter is locked by user override.
   * Checks the most recent tuning_log entry for this parameter.
   * If the most recent entry has user_override_until set and it's in the future,
   * the parameter is locked. If the most recent entry has no lock (null),
   * the parameter is unlocked.
   *
   * @param parameter - The parameter name to check
   * @returns True if the parameter is locked
   */
  isParameterLocked(parameter: string): boolean {
    // Get the most recent entry for this parameter (regardless of lock status)
    // Use rowid as tiebreaker for entries with same timestamp
    const stmt = this.db.prepare(`
      SELECT user_override_until
      FROM tuning_log
      WHERE parameter = ?
        AND reverted = 0
      ORDER BY timestamp DESC, rowid DESC
      LIMIT 1
    `);
    const row = stmt.get(parameter) as { user_override_until: string | null } | undefined;

    // No entry means no lock
    if (!row) {
      return false;
    }

    // Most recent entry has no lock (was unlocked)
    if (!row.user_override_until) {
      return false;
    }

    // Check if the lock has expired
    const lockUntil = new Date(row.user_override_until);
    return lockUntil > new Date();
  }

  /**
   * Log a tuning change to the tuning_log table.
   * @param parameter - The parameter name
   * @param oldValue - Previous value
   * @param newValue - New value
   * @param reason - Human-readable reason
   * @param source - Source of the change: auto, agent, or user
   * @param timestamp - ISO timestamp of the change
   */
  logTuningChange(
    parameter: string,
    oldValue: number,
    newValue: number,
    reason: string,
    source: "auto" | "agent" | "user",
    timestamp: string
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO tuning_log (id, timestamp, parameter, old_value, new_value, reason, source, user_override_until, reverted)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)
    `);
    stmt.run(
      randomUUID(),
      timestamp,
      parameter,
      JSON.stringify(oldValue),
      JSON.stringify(newValue),
      reason,
      source
    );
  }
}

export default TuningEngine;
