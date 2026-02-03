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
  /** Show tuning metrics dashboard */
  metrics?: boolean;
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
 * Injection usefulness summary
 */
export interface InjectionUsefulnessSummary {
  /** Average proxy score across all feedback entries */
  avgProxyScore: number | null;
  /** Total number of injections recorded */
  totalInjections: number;
  /** Total number of tuning adjustments made */
  adjustmentCount: number;
  /** Average access frequency per injection */
  avgAccessFrequency: number;
}

/**
 * Config vs targets comparison
 */
export interface ConfigVsTargets {
  /** Current importance threshold value */
  currentImportanceThreshold: number;
  /** Importance threshold bounds */
  importanceThresholdBounds: { min: number; max: number; step: number };
  /** Current HOT tier count */
  hotTierCount: number;
  /** HOT tier target range */
  hotTargetRange: { min: number; max: number };
  /** Current WARM tier count */
  warmTierCount: number;
  /** WARM tier target range */
  warmTargetRange: { min: number; max: number };
}

/**
 * Recent tuning log entry for display
 */
export interface TuningLogEntry {
  /** Timestamp of the change */
  timestamp: string;
  /** Parameter that was changed */
  parameter: string;
  /** Previous value */
  oldValue: string;
  /** New value */
  newValue: string;
  /** Reason for the change */
  reason: string;
  /** Source: auto, agent, or user */
  source: string;
  /** Whether this is a user lock */
  isLocked: boolean;
}

/**
 * Metrics dashboard result
 */
export interface MetricsDashboardResult {
  /** Injection usefulness summary */
  injectionUsefulness: InjectionUsefulnessSummary;
  /** Config vs targets comparison */
  configVsTargets: ConfigVsTargets;
  /** Recent tuning log entries */
  recentTuningLogs: TuningLogEntry[];
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
  /** Metrics dashboard (only present when --metrics flag is used) */
  metricsDashboard?: MetricsDashboardResult;
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
 * Format metrics dashboard for CLI text output
 */
function formatMetricsOutput(metrics: MetricsDashboardResult): string {
  const lines: string[] = [];

  // Header
  lines.push("Tuning Metrics Dashboard");
  lines.push("========================");
  lines.push("");

  // Injection Usefulness Summary
  lines.push("Injection Usefulness Summary:");
  const avgScore = metrics.injectionUsefulness.avgProxyScore !== null
    ? metrics.injectionUsefulness.avgProxyScore.toFixed(3)
    : "N/A";
  lines.push(`  Avg Proxy Score:     ${avgScore}`);
  lines.push(`  Total Injections:    ${metrics.injectionUsefulness.totalInjections}`);
  lines.push(`  Adjustment Count:    ${metrics.injectionUsefulness.adjustmentCount}`);
  lines.push(`  Avg Access Freq:     ${metrics.injectionUsefulness.avgAccessFrequency.toFixed(2)}`);
  lines.push("");

  // Config vs Targets
  lines.push("Current Config vs Targets:");
  const cv = metrics.configVsTargets;
  lines.push(`  Importance Threshold: ${cv.currentImportanceThreshold.toFixed(2)} (bounds: ${cv.importanceThresholdBounds.min}-${cv.importanceThresholdBounds.max}, step: ${cv.importanceThresholdBounds.step})`);

  const hotStatus = cv.hotTierCount < cv.hotTargetRange.min ? "BELOW" :
                    cv.hotTierCount > cv.hotTargetRange.max ? "ABOVE" : "OK";
  lines.push(`  HOT Tier:             ${cv.hotTierCount} (target: ${cv.hotTargetRange.min}-${cv.hotTargetRange.max}) [${hotStatus}]`);

  const warmStatus = cv.warmTierCount < cv.warmTargetRange.min ? "BELOW" :
                     cv.warmTierCount > cv.warmTargetRange.max ? "ABOVE" : "OK";
  lines.push(`  WARM Tier:            ${cv.warmTierCount} (target: ${cv.warmTargetRange.min}-${cv.warmTargetRange.max}) [${warmStatus}]`);
  lines.push("");

  // Recent Tuning Log Entries
  lines.push("Recent Tuning Changes:");
  if (metrics.recentTuningLogs.length === 0) {
    lines.push("  No tuning changes recorded");
  } else {
    for (const entry of metrics.recentTuningLogs) {
      const timestamp = entry.timestamp.substring(0, 19).replace("T", " ");
      const lockIndicator = entry.isLocked ? " [LOCKED]" : "";
      lines.push(`  ${timestamp} | ${entry.parameter}: ${entry.oldValue} → ${entry.newValue} (${entry.source})${lockIndicator}`);
      lines.push(`    Reason: ${entry.reason}`);
    }
  }

  return lines.join("\n");
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

    // Add metrics dashboard if requested
    if (options.metrics) {
      result.metricsDashboard = this.getMetricsDashboard(tierStats);
    }

    if (options.json) {
      return JSON.stringify(result, null, 2);
    }

    // Format basic stats
    let output = formatTextOutput(result);

    // Append metrics if requested
    if (options.metrics && result.metricsDashboard) {
      output += "\n\n" + formatMetricsOutput(result.metricsDashboard);
    }

    return output;
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

  /**
   * Get metrics dashboard data for --metrics option
   */
  private getMetricsDashboard(tierStats: TierStats[]): MetricsDashboardResult {
    return {
      injectionUsefulness: this.getInjectionUsefulness(),
      configVsTargets: this.getConfigVsTargets(tierStats),
      recentTuningLogs: this.getRecentTuningLogs(),
    };
  }

  /**
   * Get injection usefulness summary from injection_feedback table
   */
  private getInjectionUsefulness(): InjectionUsefulnessSummary {
    // Check if injection_feedback table exists
    const tableCheck = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='injection_feedback'
    `);

    if (!tableCheck.get()) {
      return {
        avgProxyScore: null,
        totalInjections: 0,
        adjustmentCount: this.getAdjustmentCount(),
        avgAccessFrequency: 0,
      };
    }

    // Get aggregate stats from injection_feedback
    const stmt = this.db.prepare(`
      SELECT
        AVG(proxy_score) as avg_proxy_score,
        COUNT(*) as total_injections,
        AVG(access_frequency) as avg_access_frequency
      FROM injection_feedback
    `);

    const row = stmt.get() as {
      avg_proxy_score: number | null;
      total_injections: number;
      avg_access_frequency: number | null;
    };

    return {
      avgProxyScore: row.avg_proxy_score,
      totalInjections: row.total_injections,
      adjustmentCount: this.getAdjustmentCount(),
      avgAccessFrequency: row.avg_access_frequency ?? 0,
    };
  }

  /**
   * Get count of tuning adjustments (excluding user locks/unlocks that don't change values)
   */
  private getAdjustmentCount(): number {
    // Check if tuning_log table exists
    const tableCheck = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='tuning_log'
    `);

    if (!tableCheck.get()) {
      return 0;
    }

    // Count adjustments where old_value != new_value (actual parameter changes)
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM tuning_log
      WHERE old_value != new_value AND reverted = 0
    `);

    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Get current config values vs target ranges
   */
  private getConfigVsTargets(tierStats: TierStats[]): ConfigVsTargets {
    // Get current importance threshold from tuning_log or config default
    const currentThreshold = this.getCurrentImportanceThreshold();

    // Get tier counts from provided stats
    const hotCount = tierStats.find(t => t.tier === Tier.HOT)?.count ?? 0;
    const warmCount = tierStats.find(t => t.tier === Tier.WARM)?.count ?? 0;

    // Get bounds from config
    const bounds = this.config.tuning.autoAdjust.importanceThreshold;
    const hotTarget = this.config.tuning.autoAdjust.hotTargetSize;
    const warmTarget = this.config.tuning.autoAdjust.warmTargetSize;

    return {
      currentImportanceThreshold: currentThreshold,
      importanceThresholdBounds: {
        min: bounds.min,
        max: bounds.max,
        step: bounds.step,
      },
      hotTierCount: hotCount,
      hotTargetRange: {
        min: hotTarget.min,
        max: hotTarget.max,
      },
      warmTierCount: warmCount,
      warmTargetRange: {
        min: warmTarget.min,
        max: warmTarget.max,
      },
    };
  }

  /**
   * Get current importance threshold from tuning_log or config default
   */
  private getCurrentImportanceThreshold(): number {
    // Check if tuning_log table exists
    const tableCheck = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='tuning_log'
    `);

    if (!tableCheck.get()) {
      return this.config.injection.minScore;
    }

    // Get most recent non-reverted importanceThreshold value
    const stmt = this.db.prepare(`
      SELECT new_value
      FROM tuning_log
      WHERE parameter = 'importanceThreshold' AND reverted = 0
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    const row = stmt.get() as { new_value: string } | undefined;

    if (row) {
      try {
        return JSON.parse(row.new_value);
      } catch {
        return this.config.injection.minScore;
      }
    }

    return this.config.injection.minScore;
  }

  /**
   * Get recent tuning log entries (last 10)
   */
  private getRecentTuningLogs(): TuningLogEntry[] {
    // Check if tuning_log table exists
    const tableCheck = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='tuning_log'
    `);

    if (!tableCheck.get()) {
      return [];
    }

    // Get recent entries
    const stmt = this.db.prepare(`
      SELECT timestamp, parameter, old_value, new_value, reason, source, user_override_until
      FROM tuning_log
      WHERE reverted = 0
      ORDER BY timestamp DESC
      LIMIT 10
    `);

    const rows = stmt.all() as Array<{
      timestamp: string;
      parameter: string;
      old_value: string;
      new_value: string;
      reason: string;
      source: string;
      user_override_until: string | null;
    }>;

    return rows.map(row => {
      // Check if this entry represents an active lock
      const isLocked = row.user_override_until !== null &&
        new Date(row.user_override_until) > new Date();

      // Format values for display (parse JSON if needed)
      let oldValue = row.old_value;
      let newValue = row.new_value;
      try {
        const oldParsed = JSON.parse(row.old_value);
        const newParsed = JSON.parse(row.new_value);
        if (typeof oldParsed === "number") {
          oldValue = oldParsed.toFixed(2);
        }
        if (typeof newParsed === "number") {
          newValue = newParsed.toFixed(2);
        }
      } catch {
        // Keep original string values if not valid JSON
      }

      return {
        timestamp: row.timestamp,
        parameter: row.parameter,
        oldValue,
        newValue,
        reason: row.reason,
        source: row.source,
        isLocked,
      };
    });
  }
}

export default MemoryStatsCommand;
