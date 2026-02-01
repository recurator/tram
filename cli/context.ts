/**
 * CLI context commands - Manage current task context from the command line.
 * Commands:
 *   memory set-context <text> --ttl <hours>
 *   memory clear-context
 */

import type { Database as SqliteDb } from "better-sqlite3";
import { MemorySetContextTool } from "../tools/memory_set_context.js";
import { MemoryClearContextTool } from "../tools/memory_clear_context.js";

/**
 * CLI set-context command options
 */
export interface SetContextOptions {
  /** Time-to-live in hours (default: 4) */
  ttl?: number;
  /** Output as JSON */
  json?: boolean;
}

/**
 * CLI clear-context command options
 */
export interface ClearContextOptions {
  /** Output as JSON */
  json?: boolean;
}

/**
 * Set-context command result
 */
export interface SetContextCommandResult {
  /** Context ID (always 'active') */
  id: string;
  /** The context text */
  text: string;
  /** When the context was created (ISO 8601) */
  createdAt: string;
  /** TTL in seconds */
  ttlSeconds: number;
  /** TTL in hours (for display) */
  ttlHours: number;
  /** When the context will expire (ISO 8601) */
  expiresAt: string;
  /** Success message */
  message: string;
}

/**
 * Clear-context command result
 */
export interface ClearContextCommandResult {
  /** Whether a context was actually cleared */
  cleared: boolean;
  /** Previous context text if it existed (truncated for display) */
  previousText?: string;
  /** Success message */
  message: string;
}

/**
 * Format set-context result for CLI text output
 */
function formatSetContextOutput(result: SetContextCommandResult): string {
  const lines: string[] = [];

  lines.push("Context Set");
  lines.push("===========");
  lines.push("");
  lines.push(`Text: ${result.text}`);
  lines.push(`TTL: ${result.ttlHours} hours`);
  lines.push(`Expires: ${result.expiresAt}`);
  lines.push("");
  lines.push(result.message);

  return lines.join("\n");
}

/**
 * Format clear-context result for CLI text output
 */
function formatClearContextOutput(result: ClearContextCommandResult): string {
  const lines: string[] = [];

  lines.push("Context Cleared");
  lines.push("===============");
  lines.push("");

  if (result.cleared && result.previousText) {
    lines.push(`Previous text: ${result.previousText}`);
    lines.push("");
  }

  lines.push(result.message);

  return lines.join("\n");
}

/**
 * Truncate text for display
 */
function truncateText(text: string, maxLength: number = 80): string {
  // Convert to single line
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return singleLine.substring(0, maxLength - 3) + "...";
}

/**
 * MemorySetContextCommand implements the CLI set-context functionality.
 */
export class MemorySetContextCommand {
  private setContextTool: MemorySetContextTool;

  constructor(db: SqliteDb) {
    this.setContextTool = new MemorySetContextTool(db);
  }

  /**
   * Execute the set-context command
   * @param text - Context text to set
   * @param options - Set-context options
   * @returns Formatted output string
   */
  async execute(text: string, options: SetContextOptions = {}): Promise<string> {
    // Validate text
    if (!text || typeof text !== "string") {
      throw new Error("Context text is required");
    }

    const trimmedText = text.trim();
    if (trimmedText.length === 0) {
      throw new Error("Context text cannot be empty");
    }

    // Validate TTL if provided
    if (options.ttl !== undefined) {
      if (typeof options.ttl !== "number" || options.ttl <= 0) {
        throw new Error("TTL must be a positive number of hours");
      }
    }

    // Execute the set-context tool
    const result = await this.setContextTool.execute({
      text: trimmedText,
      ttlHours: options.ttl,
    });

    // Calculate TTL in hours for display
    const ttlHours = result.details.ttl_seconds / 3600;

    // Build command result
    const commandResult: SetContextCommandResult = {
      id: result.details.id,
      text: result.details.text,
      createdAt: result.details.created_at,
      ttlSeconds: result.details.ttl_seconds,
      ttlHours,
      expiresAt: result.details.expires_at,
      message: result.content[0].text,
    };

    // Format output
    if (options.json) {
      return JSON.stringify(commandResult, null, 2);
    }

    return formatSetContextOutput(commandResult);
  }
}

/**
 * MemoryClearContextCommand implements the CLI clear-context functionality.
 */
export class MemoryClearContextCommand {
  private clearContextTool: MemoryClearContextTool;

  constructor(db: SqliteDb) {
    this.clearContextTool = new MemoryClearContextTool(db);
  }

  /**
   * Execute the clear-context command
   * @param options - Clear-context options
   * @returns Formatted output string
   */
  async execute(options: ClearContextOptions = {}): Promise<string> {
    // Execute the clear-context tool
    const result = await this.clearContextTool.execute();

    // Build command result
    const commandResult: ClearContextCommandResult = {
      cleared: result.details.cleared,
      previousText: result.details.previousText
        ? truncateText(result.details.previousText)
        : undefined,
      message: result.content[0].text,
    };

    // Format output
    if (options.json) {
      return JSON.stringify(commandResult, null, 2);
    }

    return formatClearContextOutput(commandResult);
  }
}

export default { MemorySetContextCommand, MemoryClearContextCommand };
