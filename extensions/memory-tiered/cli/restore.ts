/**
 * CLI restore command - Restore forgotten memories from the command line.
 * Command: openclaw memory restore <id>
 */

import type { Database as SqliteDb } from "better-sqlite3";
import { MemoryRestoreTool } from "../tools/memory_restore.js";

/**
 * CLI restore command options
 */
export interface RestoreOptions {
  /** Output as JSON */
  json?: boolean;
}

/**
 * Restore command result
 */
export interface RestoreCommandResult {
  /** Memory ID that was restored */
  memoryId: string;
  /** Memory text (truncated) */
  text: string;
  /** Memory tier */
  tier: string;
  /** Success message */
  message: string;
}

/**
 * Format restore result for CLI text output
 */
function formatTextOutput(result: RestoreCommandResult): string {
  const lines: string[] = [];

  lines.push("Memory Restored");
  lines.push("===============");
  lines.push(`Memory ID: ${result.memoryId}`);
  lines.push(`Tier: ${result.tier}`);
  lines.push(`Text: ${result.text}`);
  lines.push("");
  lines.push(result.message);

  return lines.join("\n");
}

/**
 * MemoryRestoreCommand implements the CLI restore functionality.
 */
export class MemoryRestoreCommand {
  private restoreTool: MemoryRestoreTool;

  constructor(db: SqliteDb) {
    this.restoreTool = new MemoryRestoreTool(db);
  }

  /**
   * Execute the restore command
   * @param memoryId - Memory ID to restore
   * @param options - Restore options
   * @returns Formatted output string
   */
  async execute(memoryId: string, options: RestoreOptions = {}): Promise<string> {
    // Validate memoryId
    if (!memoryId || typeof memoryId !== "string") {
      throw new Error("Memory ID is required");
    }

    const trimmedId = memoryId.trim();
    if (trimmedId.length === 0) {
      throw new Error("Memory ID cannot be empty");
    }

    // Execute the restore tool
    const result = await this.restoreTool.execute({
      memoryId: trimmedId,
    });

    // Build command result
    const commandResult: RestoreCommandResult = {
      memoryId: result.details.id,
      text: result.details.text,
      tier: result.details.tier,
      message: result.content[0].text,
    };

    // Format output
    if (options.json) {
      return JSON.stringify(commandResult, null, 2);
    }

    return formatTextOutput(commandResult);
  }
}

export default MemoryRestoreCommand;
