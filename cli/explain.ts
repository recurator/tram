/**
 * CLI explain command - Understand memory scoring from CLI.
 * Command: openclaw memory explain <id>
 * Options: --query <query> for similarity calculation, --json for JSON output
 */

import type { Database as SqliteDb } from "better-sqlite3";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { VectorHelper } from "../db/vectors.js";
import { MemoryScorer } from "../core/scorer.js";
import {
  MemoryExplainTool,
  type MemoryExplainInput,
  type MemoryExplanationDetails,
} from "../tools/memory_explain.js";

/**
 * UUID regex pattern for validation
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * CLI explain command options
 */
export interface ExplainOptions {
  /** Optional query for similarity calculation */
  query?: string;
  /** Output as JSON */
  json?: boolean;
}

/**
 * Explain command result (matches tool result structure)
 */
export interface ExplainCommandResult {
  /** Memory ID */
  id: string;
  /** Full memory text */
  text: string;
  /** Current tier */
  tier: string;
  /** Memory type */
  memoryType: string;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last access timestamp (ISO 8601) */
  lastAccessedAt: string;
  /** Effective age in days */
  effectiveAgeDays: number;
  /** Total access count */
  useCount: number;
  /** Array of distinct access days (YYYY-MM-DD) */
  useDays: string[];
  /** Scoring breakdown */
  scoring: {
    similarityValue: number;
    similarityComponent: number;
    recencyComponent: number;
    frequencyComponent: number;
    totalScore: number;
    effectiveAgeDays: number;
    halfLifeDays: number;
  };
  /** Injection eligibility */
  injection: {
    eligible: boolean;
    reason: string;
    isPinned: boolean;
    isForgotten: boolean;
    tier: string;
  };
  /** Query used for similarity (if provided) */
  queryUsed?: string;
}

/**
 * Format explain result for CLI text output
 */
function formatTextOutput(result: ExplainCommandResult): string {
  const lines: string[] = [];

  // Header
  lines.push("Memory Explanation");
  lines.push("==================");
  lines.push("");

  // Basic info
  lines.push(`ID: ${result.id}`);
  lines.push(`Tier: ${result.tier}`);
  lines.push(`Type: ${result.memoryType} (half-life: ${result.scoring.halfLifeDays} days)`);
  lines.push("");

  // Text content
  lines.push("Text:");
  lines.push(`  ${result.text}`);
  lines.push("");

  // Timestamps
  lines.push("Timestamps:");
  lines.push(`  Created:       ${result.createdAt}`);
  lines.push(`  Last Accessed: ${result.lastAccessedAt}`);
  lines.push(`  Effective Age: ${result.effectiveAgeDays.toFixed(2)} days`);
  lines.push("");

  // Usage stats
  lines.push("Usage Statistics:");
  lines.push(`  Use Count: ${result.useCount}`);
  lines.push(`  Use Days:  ${result.useDays.length} distinct day(s)`);
  if (result.useDays.length > 0) {
    const displayDays = result.useDays.slice(0, 5);
    const moreCount = result.useDays.length - displayDays.length;
    const daysStr =
      moreCount > 0
        ? `${displayDays.join(", ")} (+${moreCount} more)`
        : displayDays.join(", ");
    lines.push(`             [${daysStr}]`);
  }
  lines.push("");

  // Scoring breakdown
  lines.push("Scoring Breakdown:");
  if (result.queryUsed) {
    lines.push(`  Query: "${result.queryUsed}"`);
  }
  lines.push(
    `  Similarity: ${result.scoring.similarityValue.toFixed(4)} → weighted: ${result.scoring.similarityComponent.toFixed(4)}`
  );
  lines.push(
    `  Recency:    exp(-${result.scoring.effectiveAgeDays.toFixed(2)}/${result.scoring.halfLifeDays}) → weighted: ${result.scoring.recencyComponent.toFixed(4)}`
  );
  lines.push(
    `  Frequency:  log(1+${result.useCount}) → weighted: ${result.scoring.frequencyComponent.toFixed(4)}`
  );
  lines.push(`  Total Score: ${result.scoring.totalScore.toFixed(4)}`);
  lines.push("");

  // Injection eligibility
  lines.push("Injection Eligibility:");
  lines.push(`  Eligible: ${result.injection.eligible ? "Yes" : "No"}`);
  lines.push(`  Reason:   ${result.injection.reason}`);
  if (result.injection.isPinned) {
    lines.push("  Pinned:   Yes (bypasses decay)");
  }
  if (result.injection.isForgotten) {
    lines.push("  Forgotten: Yes (soft-deleted)");
  }

  return lines.join("\n");
}

/**
 * MemoryExplainCommand implements the CLI explain functionality.
 * Wraps the MemoryExplainTool for command-line usage.
 */
export class MemoryExplainCommand {
  private explainTool: MemoryExplainTool;

  constructor(
    db: SqliteDb,
    embeddingProvider?: EmbeddingProvider,
    vectorHelper?: VectorHelper,
    scorer?: MemoryScorer
  ) {
    this.explainTool = new MemoryExplainTool(
      db,
      embeddingProvider,
      vectorHelper,
      scorer
    );
  }

  /**
   * Execute the explain command
   * @param memoryId - The memory ID to explain
   * @param options - Explain options
   * @returns Formatted output string
   */
  async execute(memoryId: string, options: ExplainOptions = {}): Promise<string> {
    // Validate memory ID
    if (!memoryId || typeof memoryId !== "string") {
      throw new Error("Memory ID is required");
    }

    const trimmedId = memoryId.trim();
    if (trimmedId.length === 0) {
      throw new Error("Memory ID cannot be empty");
    }

    // Validate UUID format
    if (!UUID_REGEX.test(trimmedId)) {
      throw new Error(`Invalid memory ID format: ${trimmedId}`);
    }

    // Prepare tool input
    const input: MemoryExplainInput = {
      memoryId: trimmedId,
      query: options.query,
    };

    // Execute the underlying tool
    const toolResult = await this.explainTool.execute(input);
    const details = toolResult.details;

    // Build command result
    const commandResult: ExplainCommandResult = {
      id: details.id,
      text: details.text,
      tier: details.tier,
      memoryType: details.memoryType,
      createdAt: details.createdAt,
      lastAccessedAt: details.lastAccessedAt,
      effectiveAgeDays: details.effectiveAgeDays,
      useCount: details.useCount,
      useDays: details.useDays,
      scoring: {
        similarityValue: details.scoring.similarityValue,
        similarityComponent: details.scoring.similarityComponent,
        recencyComponent: details.scoring.recencyComponent,
        frequencyComponent: details.scoring.frequencyComponent,
        totalScore: details.scoring.totalScore,
        effectiveAgeDays: details.scoring.effectiveAgeDays,
        halfLifeDays: details.scoring.halfLifeDays,
      },
      injection: {
        eligible: details.injection.eligible,
        reason: details.injection.reason,
        isPinned: details.injection.isPinned,
        isForgotten: details.injection.isForgotten,
        tier: details.injection.tier,
      },
      queryUsed: options.query,
    };

    // Format output
    if (options.json) {
      return JSON.stringify(commandResult, null, 2);
    }

    return formatTextOutput(commandResult);
  }
}

export default MemoryExplainCommand;
