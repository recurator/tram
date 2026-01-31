/**
 * CLI stats command - Display memory statistics.
 * Command: openclaw memory stats
 * Shows tier counts, forgotten/pinned counts, memory types, DB size,
 * context status, embedding provider, and last decay run.
 */

import type { Database as SqliteDb } from "better-sqlite3";
import { statSync } from "node:fs";
import { Tier, MemoryType } from "../core/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import type { ResolvedConfig } from "../config.js";

/**
 * CLI stats command options
 */
export interface StatsOptions {
  /** Output as JSON */
  json?: boolean;
}

/**
 * Tier count information
 */
export interface TierStats {
  tier: Tier;
  count: number;
  percentage: number;
}

/**
 * Memory type distribution
 */
export interface MemoryTypeStats {
  type: MemoryType;
  count: number;
  percentage: number;
}

/**
 * Current context status
 */
export interface ContextStatus {
  status: "active" | "expired" | "none";
  text?: string;
  createdAt?: string;
  expiresAt?: string;
  ttlSeconds?: number;
}

/**
 * Embedding provider information
 */
export interface EmbeddingInfo {
  provider: string;
  model: string;
  dimensions: number;
}

/**
 * Stats command result
 */
export interface StatsCommandResult {
  /** Total memory count */
  totalCount: number;
  /** Counts by tier */
  tierStats: TierStats[];
  /** Forgotten memory count */
  forgottenCount: number;
  /** Pinned memory count */
  pinnedCount: number;
  /** Memory type distribution */
  memoryTypeStats: MemoryTypeStats[];
  /** Database file size in bytes */
  dbFileSize: number;
  /** Database file size formatted for display */
  dbFileSizeFormatted: string;
  /** Current context status */
  contextStatus: ContextStatus;
  /** Embedding provider info */
  embeddingInfo: EmbeddingInfo;
  /** Last decay run timestamp (ISO 8601) or null if never run */
  lastDecayRun: string | null;
}

/**
 * Format bytes to human-readable size
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

/**
 * Format stats for CLI text output
 */
function formatTextOutput(result: StatsCommandResult): string {
  const lines: string[] = [];

  // Header
  lines.push("Memory Statistics");
  lines.push("=================");
  lines.push("");

  // Tier counts with bar chart
  lines.push("Tier Distribution:");
  for (const { tier, count, percentage } of result.tierStats) {
    const bar = "█".repeat(Math.min(Math.ceil(percentage / 5), 20));
    lines.push(
      `  ${tier.padEnd(8)} ${String(count).padStart(5)}  ${percentage.toFixed(1).padStart(5)}%  ${bar}`
    );
  }
  lines.push(`  ${"Total".padEnd(8)} ${String(result.totalCount).padStart(5)}`);
  lines.push("");

  // Forgotten and pinned counts
  lines.push("State Counts:");
  lines.push(`  Forgotten: ${result.forgottenCount}`);
  lines.push(`  Pinned:    ${result.pinnedCount}`);
  lines.push("");

  // Memory type distribution
  lines.push("Memory Types:");
  for (const { type, count, percentage } of result.memoryTypeStats) {
    lines.push(
      `  ${type.padEnd(12)} ${String(count).padStart(5)}  ${percentage.toFixed(1).padStart(5)}%`
    );
  }
  lines.push("");

  // Database info
  lines.push("Database:");
  lines.push(`  File size: ${result.dbFileSizeFormatted}`);
  lines.push("");

  // Current context
  lines.push("Current Context:");
  if (result.contextStatus.status === "active") {
    const textPreview =
      result.contextStatus.text && result.contextStatus.text.length > 50
        ? result.contextStatus.text.substring(0, 47) + "..."
        : result.contextStatus.text;
    lines.push(`  Status:  active`);
    lines.push(`  Text:    ${textPreview}`);
    lines.push(`  Expires: ${result.contextStatus.expiresAt}`);
  } else if (result.contextStatus.status === "expired") {
    lines.push(`  Status: expired`);
  } else {
    lines.push(`  Status: none`);
  }
  lines.push("");

  // Embedding provider
  lines.push("Embedding Provider:");
  lines.push(`  Provider:   ${result.embeddingInfo.provider}`);
  lines.push(`  Model:      ${result.embeddingInfo.model}`);
  lines.push(`  Dimensions: ${result.embeddingInfo.dimensions}`);
  lines.push("");

  // Last decay run
  lines.push("Decay Service:");
  if (result.lastDecayRun) {
    lines.push(`  Last run: ${result.lastDecayRun}`);
  } else {
    lines.push(`  Last run: never`);
  }

  return lines.join("\n");
}

/**
 * MemoryStatsCommand implements the CLI stats functionality.
 */
export class MemoryStatsCommand {
  private db: SqliteDb;
  private dbPath: string;
  private embeddingProvider: EmbeddingProvider;
  private config: ResolvedConfig;

  constructor(
    db: SqliteDb,
    dbPath: string,
    embeddingProvider: EmbeddingProvider,
    config: ResolvedConfig
  ) {
    this.db = db;
    this.dbPath = dbPath;
    this.embeddingProvider = embeddingProvider;
    this.config = config;
  }

  /**
   * Execute the stats command
   * @param options - Stats options
   * @returns Formatted output string
   */
  async execute(options: StatsOptions = {}): Promise<string> {
    // Get tier counts
    const tierStats = this.getTierStats();
    const totalCount = tierStats.reduce((sum, t) => sum + t.count, 0);

    // Get forgotten count
    const forgottenCount = this.getStateCount("do_not_inject");

    // Get pinned count
    const pinnedCount = this.getStateCount("pinned");

    // Get memory type distribution
    const memoryTypeStats = this.getMemoryTypeStats(totalCount);

    // Get database file size
    const dbFileSize = this.getDbFileSize();

    // Get current context status
    const contextStatus = this.getContextStatus();

    // Get embedding provider info
    const embeddingInfo = this.getEmbeddingInfo();

    // Get last decay run
    const lastDecayRun = this.getLastDecayRun();

    const result: StatsCommandResult = {
      totalCount,
      tierStats,
      forgottenCount,
      pinnedCount,
      memoryTypeStats,
      dbFileSize,
      dbFileSizeFormatted: formatBytes(dbFileSize),
      contextStatus,
      embeddingInfo,
      lastDecayRun,
    };

    if (options.json) {
      return JSON.stringify(result, null, 2);
    }

    return formatTextOutput(result);
  }

  /**
   * Get tier counts with percentages
   */
  private getTierStats(): TierStats[] {
    const stmt = this.db.prepare(`
      SELECT tier, COUNT(*) as count
      FROM memories
      GROUP BY tier
    `);

    const rows = stmt.all() as Array<{ tier: string; count: number }>;
    const countMap = new Map(rows.map((r) => [r.tier, r.count]));
    const totalCount = rows.reduce((sum, r) => sum + r.count, 0);

    const tierOrder: Tier[] = [Tier.HOT, Tier.WARM, Tier.COLD, Tier.ARCHIVE];

    return tierOrder.map((tier) => {
      const count = countMap.get(tier) ?? 0;
      return {
        tier,
        count,
        percentage: totalCount > 0 ? (count / totalCount) * 100 : 0,
      };
    });
  }

  /**
   * Get count of memories with a specific boolean state
   */
  private getStateCount(column: "do_not_inject" | "pinned"): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM memories WHERE ${column} = 1
    `);
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Get memory type distribution
   */
  private getMemoryTypeStats(totalCount: number): MemoryTypeStats[] {
    const stmt = this.db.prepare(`
      SELECT memory_type, COUNT(*) as count
      FROM memories
      GROUP BY memory_type
    `);

    const rows = stmt.all() as Array<{ memory_type: string; count: number }>;
    const countMap = new Map(rows.map((r) => [r.memory_type, r.count]));

    const typeOrder: MemoryType[] = [
      MemoryType.procedural,
      MemoryType.factual,
      MemoryType.project,
      MemoryType.episodic,
    ];

    return typeOrder.map((type) => {
      const count = countMap.get(type) ?? 0;
      return {
        type,
        count,
        percentage: totalCount > 0 ? (count / totalCount) * 100 : 0,
      };
    });
  }

  /**
   * Get database file size in bytes
   */
  private getDbFileSize(): number {
    try {
      const stats = statSync(this.dbPath);
      return stats.size;
    } catch {
      return 0;
    }
  }

  /**
   * Get current context status
   */
  private getContextStatus(): ContextStatus {
    const stmt = this.db.prepare(`
      SELECT id, text, created_at, ttl_seconds
      FROM current_context
      WHERE id = 'active'
    `);

    const row = stmt.get() as {
      id: string;
      text: string;
      created_at: string;
      ttl_seconds: number;
    } | undefined;

    if (!row) {
      return { status: "none" };
    }

    // Check if context has expired
    const createdAt = new Date(row.created_at);
    const expiresAt = new Date(createdAt.getTime() + row.ttl_seconds * 1000);
    const now = new Date();

    if (now > expiresAt) {
      return { status: "expired" };
    }

    return {
      status: "active",
      text: row.text,
      createdAt: row.created_at,
      expiresAt: expiresAt.toISOString(),
      ttlSeconds: row.ttl_seconds,
    };
  }

  /**
   * Get embedding provider information
   */
  private getEmbeddingInfo(): EmbeddingInfo {
    return {
      provider: this.config.embedding.provider,
      model: this.embeddingProvider.getModelName(),
      dimensions: this.embeddingProvider.getDimensions(),
    };
  }

  /**
   * Get last decay run timestamp from database metadata
   */
  private getLastDecayRun(): string | null {
    // Check if meta table exists
    const tableCheck = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='meta'
    `);

    if (!tableCheck.get()) {
      return null;
    }

    // Get last decay run from meta table
    const stmt = this.db.prepare(`
      SELECT value FROM meta WHERE key = 'last_decay_run'
    `);

    const row = stmt.get() as { value: string } | undefined;
    return row?.value ?? null;
  }
}

export default MemoryStatsCommand;
