/**
 * CLI pin command - Pin memories from the command line.
 * Command: openclaw memory pin <id>
 */

import type { Database as SqliteDb } from "better-sqlite3";
import { MemoryPinTool } from "../tools/memory_pin.js";

/**
 * CLI pin command options
 */
export interface PinOptions {
  /** Output as JSON */
  json?: boolean;
}

/**
 * Pin command result
 */
export interface PinCommandResult {
  /** Memory ID that was pinned */
  memoryId: string;
  /** Memory text (truncated) */
  text: string;
  /** Memory tier (may have been updated) */
  tier: string;
  /** Whether the tier was updated */
  tierUpdated: boolean;
  /** Success message */
  message: string;
}

/**
 * Format pin result for CLI text output
 */
function formatTextOutput(result: PinCommandResult): string {
  const lines: string[] = [];

  lines.push("Memory Pinned");
  lines.push("=============");
  lines.push(`Memory ID: ${result.memoryId}`);
  lines.push(`Tier: ${result.tier}${result.tierUpdated ? " (updated)" : ""}`);
  lines.push(`Text: ${result.text}`);
  lines.push("");
  lines.push(result.message);

  return lines.join("\n");
}

/**
 * MemoryPinCommand implements the CLI pin functionality.
 */
export class MemoryPinCommand {
  private pinTool: MemoryPinTool;

  constructor(db: SqliteDb) {
    this.pinTool = new MemoryPinTool(db);
  }

  /**
   * Execute the pin command
   * @param memoryId - Memory ID to pin
   * @param options - Pin options
   * @returns Formatted output string
   */
  async execute(memoryId: string, options: PinOptions = {}): Promise<string> {
    // Validate memoryId
    if (!memoryId || typeof memoryId !== "string") {
      throw new Error("Memory ID is required");
    }

    const trimmedId = memoryId.trim();
    if (trimmedId.length === 0) {
      throw new Error("Memory ID cannot be empty");
    }

    // Execute the pin tool
    const result = await this.pinTool.execute({
      memoryId: trimmedId,
    });

    // Build command result
    const commandResult: PinCommandResult = {
      memoryId: result.details.id,
      text: result.details.text,
      tier: result.details.tier,
      tierUpdated: result.details.tierUpdated,
      message: result.content[0].text,
    };

    // Format output
    if (options.json) {
      return JSON.stringify(commandResult, null, 2);
    }

    return formatTextOutput(commandResult);
  }
}

export default MemoryPinCommand;
