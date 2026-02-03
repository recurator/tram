/**
 * CLI lock/unlock commands - Lock or unlock parameters from auto-tuning.
 * Commands:
 *   - tram lock <parameter>: Lock a parameter to prevent auto-tuning
 *   - tram unlock <parameter>: Remove lock from a parameter
 *
 * Locked parameters are skipped by TuningEngine until the lock expires.
 * Lock duration is controlled by config.tuning.lockDurationDays.
 */

import { randomUUID } from "node:crypto";
import type { Database as SqliteDb } from "better-sqlite3";
import type { ResolvedConfig } from "../config.js";

/**
 * Valid tuning parameters that can be locked
 */
export const LOCKABLE_PARAMETERS = [
  "importanceThreshold",
] as const;

export type LockableParameter = (typeof LOCKABLE_PARAMETERS)[number];

/**
 * Check if a parameter name is valid and lockable
 */
export function isLockableParameter(param: string): param is LockableParameter {
  return LOCKABLE_PARAMETERS.includes(param as LockableParameter);
}

/**
 * CLI lock command options
 */
export interface LockOptions {
  /** Output as JSON */
  json?: boolean;
}

/**
 * Lock command result
 */
export interface LockCommandResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** The parameter that was locked/unlocked */
  parameter: string;
  /** Action performed: lock or unlock */
  action: "lock" | "unlock";
  /** Lock expiration date (for lock action) */
  lockedUntil?: string;
  /** Current value of the parameter */
  currentValue?: number;
  /** Human-readable message */
  message: string;
}

/**
 * Format lock result for CLI text output
 */
function formatTextOutput(result: LockCommandResult): string {
  const lines: string[] = [];

  if (result.action === "lock") {
    lines.push(`Parameter Lock: ${result.parameter}`);
    lines.push("=".repeat(30));
    lines.push("");
    if (result.success) {
      lines.push(`✓ Parameter '${result.parameter}' locked`);
      lines.push(`  Current value: ${result.currentValue}`);
      lines.push(`  Locked until: ${result.lockedUntil}`);
      lines.push("");
      lines.push("Auto-tuning will skip this parameter until the lock expires.");
      lines.push("Use 'tram-unlock " + result.parameter + "' to remove the lock.");
    } else {
      lines.push(`✗ ${result.message}`);
    }
  } else {
    lines.push(`Parameter Unlock: ${result.parameter}`);
    lines.push("=".repeat(30));
    lines.push("");
    if (result.success) {
      lines.push(`✓ Parameter '${result.parameter}' unlocked`);
      lines.push(`  Current value: ${result.currentValue}`);
      lines.push("");
      lines.push("Auto-tuning will now adjust this parameter as needed.");
    } else {
      lines.push(`✗ ${result.message}`);
    }
  }

  return lines.join("\n");
}

/**
 * MemoryLockCommand implements CLI lock/unlock functionality.
 */
export class MemoryLockCommand {
  private db: SqliteDb;
  private config: ResolvedConfig;

  constructor(db: SqliteDb, config: ResolvedConfig) {
    this.db = db;
    this.config = config;
  }

  /**
   * Lock a parameter to prevent auto-tuning.
   * Creates a tuning_log entry with user_override_until set.
   *
   * @param parameter - The parameter name to lock
   * @param options - Command options
   * @returns Formatted output string
   */
  lock(parameter: string, options: LockOptions = {}): string {
    // Validate parameter name
    if (!isLockableParameter(parameter)) {
      const result: LockCommandResult = {
        success: false,
        parameter,
        action: "lock",
        message: `Invalid parameter '${parameter}'. Valid parameters: ${LOCKABLE_PARAMETERS.join(", ")}`,
      };
      return options.json ? JSON.stringify(result, null, 2) : formatTextOutput(result);
    }

    // Get current value
    const currentValue = this.getCurrentValue(parameter);

    // Calculate lock expiration date
    const lockUntil = new Date();
    lockUntil.setDate(lockUntil.getDate() + this.config.tuning.lockDurationDays);
    const lockUntilIso = lockUntil.toISOString();

    // Create tuning_log entry with user lock
    const stmt = this.db.prepare(`
      INSERT INTO tuning_log (id, timestamp, parameter, old_value, new_value, reason, source, user_override_until, reverted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);

    stmt.run(
      randomUUID(),
      new Date().toISOString(),
      parameter,
      JSON.stringify(currentValue),
      JSON.stringify(currentValue), // Value doesn't change, just locked
      `User locked parameter for ${this.config.tuning.lockDurationDays} days`,
      "user",
      lockUntilIso
    );

    const result: LockCommandResult = {
      success: true,
      parameter,
      action: "lock",
      lockedUntil: lockUntilIso,
      currentValue,
      message: `Parameter '${parameter}' locked until ${lockUntilIso}`,
    };

    return options.json ? JSON.stringify(result, null, 2) : formatTextOutput(result);
  }

  /**
   * Unlock a parameter to allow auto-tuning.
   * Creates a tuning_log entry with user_override_until cleared.
   *
   * @param parameter - The parameter name to unlock
   * @param options - Command options
   * @returns Formatted output string
   */
  unlock(parameter: string, options: LockOptions = {}): string {
    // Validate parameter name
    if (!isLockableParameter(parameter)) {
      const result: LockCommandResult = {
        success: false,
        parameter,
        action: "unlock",
        message: `Invalid parameter '${parameter}'. Valid parameters: ${LOCKABLE_PARAMETERS.join(", ")}`,
      };
      return options.json ? JSON.stringify(result, null, 2) : formatTextOutput(result);
    }

    // Check if parameter is actually locked
    if (!this.isParameterLocked(parameter)) {
      const currentValue = this.getCurrentValue(parameter);
      const result: LockCommandResult = {
        success: false,
        parameter,
        action: "unlock",
        currentValue,
        message: `Parameter '${parameter}' is not currently locked`,
      };
      return options.json ? JSON.stringify(result, null, 2) : formatTextOutput(result);
    }

    // Get current value
    const currentValue = this.getCurrentValue(parameter);

    // Create tuning_log entry to clear the lock
    // We do this by creating a new entry without user_override_until
    const stmt = this.db.prepare(`
      INSERT INTO tuning_log (id, timestamp, parameter, old_value, new_value, reason, source, user_override_until, reverted)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)
    `);

    stmt.run(
      randomUUID(),
      new Date().toISOString(),
      parameter,
      JSON.stringify(currentValue),
      JSON.stringify(currentValue), // Value doesn't change, just unlocked
      "User unlocked parameter",
      "user"
    );

    const result: LockCommandResult = {
      success: true,
      parameter,
      action: "unlock",
      currentValue,
      message: `Parameter '${parameter}' unlocked`,
    };

    return options.json ? JSON.stringify(result, null, 2) : formatTextOutput(result);
  }

  /**
   * Get the current value of a tuning parameter.
   */
  private getCurrentValue(parameter: string): number {
    if (parameter === "importanceThreshold") {
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

      // Return default from config
      return this.config.injection.minScore;
    }

    // Fallback for unknown parameters
    return 0;
  }

  /**
   * Check if a parameter is currently locked.
   * Checks the most recent tuning_log entry for this parameter.
   */
  private isParameterLocked(parameter: string): boolean {
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
}

export default MemoryLockCommand;
