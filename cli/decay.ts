/**
 * CLI decay command - Manually trigger decay and promotion cycles.
 * Command: openclaw memory decay run
 * Runs DecayEngine and PromotionEngine immediately and shows counts.
 */

import type { Database as SqliteDb } from "better-sqlite3";
import { DecayEngine, type DecayResult } from "../core/decay.js";
import { PromotionEngine, type PromotionResult } from "../core/promotion.js";
import type { ResolvedConfig } from "../config.js";

/**
 * CLI decay run command options
 */
export interface DecayRunOptions {
  /** Output as JSON */
  json?: boolean;
}

/**
 * Decay run command result
 */
export interface DecayRunCommandResult {
  /** Decay engine result */
  decay: DecayResult;
  /** Promotion engine result */
  promotion: PromotionResult;
  /** Total demoted memories (HOT + WARM) */
  totalDemoted: number;
  /** Total promoted memories */
  totalPromoted: number;
  /** Success message */
  message: string;
}

/**
 * Format decay run result for CLI text output
 */
function formatTextOutput(result: DecayRunCommandResult): string {
  const lines: string[] = [];

  // Header
  lines.push("Decay Run Complete");
  lines.push("==================");
  lines.push("");

  // Decay results
  lines.push("Demotions:");
  lines.push(`  HOT → COLD:  ${result.decay.hotDemoted}`);
  lines.push(`  WARM → COLD: ${result.decay.warmDemoted}`);
  lines.push(`  Total:       ${result.totalDemoted}`);
  lines.push("");

  // Promotion results
  lines.push("Promotions:");
  lines.push(`  COLD → WARM: ${result.promotion.promoted}`);
  lines.push("");

  // Processing summary
  lines.push("Processing:");
  lines.push(`  Memories checked for decay:     ${result.decay.totalProcessed}`);
  lines.push(`  Memories checked for promotion: ${result.promotion.totalProcessed}`);
  lines.push("");

  // Timestamp
  lines.push(`Run completed at: ${result.decay.runAt}`);

  return lines.join("\n");
}

/**
 * MemoryDecayCommand implements the CLI decay run functionality.
 * Runs decay and promotion engines immediately and reports results.
 */
export class MemoryDecayCommand {
  private db: SqliteDb;
  private config?: Partial<ResolvedConfig>;
  private decayEngine: DecayEngine;
  private promotionEngine: PromotionEngine;

  /**
   * Create a new MemoryDecayCommand instance.
   * @param db - The better-sqlite3 database instance
   * @param config - Optional resolved plugin configuration
   */
  constructor(db: SqliteDb, config?: Partial<ResolvedConfig>) {
    this.db = db;
    this.config = config;
    this.decayEngine = new DecayEngine(db, config);
    this.promotionEngine = new PromotionEngine(db, config);
  }

  /**
   * Execute the decay run command.
   * Runs decay and promotion engines immediately.
   * @param options - Command options
   * @returns Formatted output string
   */
  async execute(options: DecayRunOptions = {}): Promise<string> {
    // Run decay engine (demote stale memories)
    const decayResult = this.decayEngine.run();

    // Run promotion engine (promote frequently-used memories)
    const promotionResult = this.promotionEngine.run();

    const totalDemoted = decayResult.hotDemoted + decayResult.warmDemoted;

    const result: DecayRunCommandResult = {
      decay: decayResult,
      promotion: promotionResult,
      totalDemoted,
      totalPromoted: promotionResult.promoted,
      message: `Decay run complete: ${totalDemoted} demoted, ${promotionResult.promoted} promoted`,
    };

    if (options.json) {
      return JSON.stringify(result, null, 2);
    }

    return formatTextOutput(result);
  }
}

export default MemoryDecayCommand;
