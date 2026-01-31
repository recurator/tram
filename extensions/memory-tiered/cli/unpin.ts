/**
 * CLI unpin command - Unpin memories from the command line.
 * Command: openclaw memory unpin <id>
 */

import type { Database as SqliteDb } from "better-sqlite3";
import { MemoryUnpinTool } from "../tools/memory_unpin.js";

/**
 * CLI unpin command options
 */
export interface UnpinOptions {
  /** Output as JSON */
  json?: boolean;
}

/**
 * Unpin command result
 */
export interface UnpinCommandResult {
  /** Memory ID that was unpinned */
  memoryId: string;
  /** Memory text (truncated) */
  text: string;
  /** Memory tier */
  tier: string;
  /** Success message */
  message: string;
}

/**
 * Format unpin result for CLI text output
 */
function formatTextOutput(result: UnpinCommandResult): string {
  const lines: string[] = [];

  lines.push("Memory Unpinned");
  lines.push("===============");
  lines.push(`Memory ID: ${result.memoryId}`);
  lines.push(`Tier: ${result.tier}`);
  lines.push(`Text: ${result.text}`);
  lines.push("");
  lines.push(result.message);

  return lines.join("\n");
}

/**
 * MemoryUnpinCommand implements the CLI unpin functionality.
 */
export class MemoryUnpinCommand {
  private unpinTool: MemoryUnpinTool;

  constructor(db: SqliteDb) {
    this.unpinTool = new MemoryUnpinTool(db);
  }

  /**
   * Execute the unpin command
   * @param memoryId - Memory ID to unpin
   * @param options - Unpin options
   * @returns Formatted output string
   */
  async execute(memoryId: string, options: UnpinOptions = {}): Promise<string> {
    // Validate memoryId
    if (!memoryId || typeof memoryId !== "string") {
      throw new Error("Memory ID is required");
    }

    const trimmedId = memoryId.trim();
    if (trimmedId.length === 0) {
      throw new Error("Memory ID cannot be empty");
    }

    // Execute the unpin tool
    const result = await this.unpinTool.execute({
      memoryId: trimmedId,
    });

    // Build command result
    const commandResult: UnpinCommandResult = {
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

export default MemoryUnpinCommand;
