/**
 * CLI forget command - Forget memories from the command line.
 * Command: openclaw memory forget <id|query>
 * Options: --hard (permanent deletion), --confirm (skip confirmation for hard delete)
 */

import type { Database as SqliteDb } from "better-sqlite3";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { VectorHelper } from "../db/vectors.js";
import { MemoryForgetTool } from "../tools/memory_forget.js";

/**
 * CLI forget command options
 */
export interface ForgetOptions {
  /** Permanently delete instead of soft forget */
  hard?: boolean;
  /** Skip confirmation for hard delete */
  confirm?: boolean;
  /** Output as JSON */
  json?: boolean;
}

/**
 * Forget command result
 */
export interface ForgetCommandResult {
  /** Action performed */
  action: "soft_forget" | "hard_delete";
  /** Memory ID that was affected */
  memoryId: string;
  /** Memory text (truncated) */
  text: string;
  /** Whether the memory can be restored */
  restorable: boolean;
  /** Success message */
  message: string;
}

/**
 * UUID regex pattern for validation
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Format forget result for CLI text output
 */
function formatTextOutput(result: ForgetCommandResult): string {
  const lines: string[] = [];

  lines.push(`Action: ${result.action === "hard_delete" ? "PERMANENTLY DELETED" : "Forgotten (soft)"}`);
  lines.push(`Memory ID: ${result.memoryId}`);
  lines.push(`Text: ${result.text}`);
  lines.push("");
  lines.push(result.message);

  if (result.restorable) {
    lines.push("");
    lines.push('To restore this memory, use: openclaw memory restore <id>');
  }

  return lines.join("\n");
}

/**
 * MemoryForgetCommand implements the CLI forget functionality.
 */
export class MemoryForgetCommand {
  private forgetTool: MemoryForgetTool;

  constructor(
    db: SqliteDb,
    embeddingProvider: EmbeddingProvider,
    vectorHelper: VectorHelper
  ) {
    this.forgetTool = new MemoryForgetTool(db, embeddingProvider, vectorHelper);
  }

  /**
   * Execute the forget command
   * @param target - Memory ID or search query
   * @param options - Forget options
   * @returns Formatted output string
   */
  async execute(target: string, options: ForgetOptions = {}): Promise<string> {
    // Validate target
    if (!target || typeof target !== "string") {
      throw new Error("Memory ID or search query is required");
    }

    const trimmedTarget = target.trim();
    if (trimmedTarget.length === 0) {
      throw new Error("Memory ID or search query cannot be empty");
    }

    // Check if hard delete requires confirmation
    if (options.hard && !options.confirm) {
      throw new Error(
        "Hard delete requires --confirm flag. This action cannot be undone.\n" +
        "Use: openclaw memory forget <id|query> --hard --confirm"
      );
    }

    // Determine if target is UUID or query
    const isUuid = UUID_REGEX.test(trimmedTarget);

    // Execute the forget tool
    const result = await this.forgetTool.execute({
      memoryId: isUuid ? trimmedTarget : undefined,
      query: isUuid ? undefined : trimmedTarget,
      hard: options.hard ?? false,
    });

    // Build command result
    const commandResult: ForgetCommandResult = {
      action: result.details.hardDeleted ? "hard_delete" : "soft_forget",
      memoryId: result.details.id,
      text: result.details.text,
      restorable: result.details.restorable,
      message: result.content[0].text,
    };

    // Format output
    if (options.json) {
      return JSON.stringify(commandResult, null, 2);
    }

    return formatTextOutput(commandResult);
  }
}

export default MemoryForgetCommand;
