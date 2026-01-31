/**
 * CLI list command - List memories by tier from the command line.
 * Command: openclaw memory list
 * Options: --tier <tier>, --forgotten, --pinned, --sort <field>
 */

import type { Database as SqliteDb } from "better-sqlite3";
import { Tier, MemoryType, type Memory } from "../core/types.js";

/**
 * CLI list command options
 */
export interface ListOptions {
  /** Filter by specific tier */
  tier?: "HOT" | "WARM" | "COLD" | "ARCHIVE";
  /** Show only forgotten memories (do_not_inject = true) */
  forgotten?: boolean;
  /** Show only pinned memories */
  pinned?: boolean;
  /** Sort field (default: created_at) */
  sort?: "created_at" | "last_accessed_at" | "use_count";
  /** Maximum number of results (default: 20) */
  limit?: number;
  /** Output as JSON */
  json?: boolean;
}

/**
 * Tier count summary
 */
export interface TierCount {
  tier: Tier;
  count: number;
}

/**
 * Memory list item (simplified for display)
 */
export interface ListItem {
  /** Memory ID */
  id: string;
  /** Memory text (truncated for display) */
  text: string;
  /** Current tier */
  tier: Tier;
  /** Memory type */
  memoryType: MemoryType;
  /** Whether the memory is pinned */
  pinned: boolean;
  /** Whether the memory is forgotten (do_not_inject) */
  forgotten: boolean;
  /** When the memory was created */
  createdAt: string;
  /** When the memory was last accessed */
  lastAccessedAt: string;
  /** Number of times accessed */
  useCount: number;
}

/**
 * List command result
 */
export interface ListCommandResult {
  /** Tier counts (when showing summary) */
  tierCounts?: TierCount[];
  /** Total memory count */
  totalCount: number;
  /** Listed memories (when filtered) */
  items?: ListItem[];
  /** Filter applied */
  filter?: {
    tier?: string;
    forgotten?: boolean;
    pinned?: boolean;
    sort?: string;
  };
}

/**
 * Maximum text length for display (truncated with ellipsis)
 */
const MAX_TEXT_LENGTH = 60;

/**
 * Truncate text for display, adding ellipsis if needed
 */
function truncateText(text: string, maxLength: number = MAX_TEXT_LENGTH): string {
  const singleLine = text.replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return singleLine.substring(0, maxLength - 3) + "...";
}

/**
 * Format a single list item for CLI output
 */
function formatItem(item: ListItem): string {
  const lines: string[] = [];

  // Build tags
  const tags: string[] = [];
  if (item.pinned) {
    tags.push("[PINNED]");
  }
  if (item.forgotten) {
    tags.push("[FORGOTTEN]");
  }

  const tagStr = tags.length > 0 ? ` ${tags.join(" ")}` : "";
  lines.push(`${item.id}`);
  lines.push(`  Tier: ${item.tier} | Type: ${item.memoryType} | Uses: ${item.useCount}${tagStr}`);
  lines.push(`  Created: ${item.createdAt.substring(0, 10)} | Accessed: ${item.lastAccessedAt.substring(0, 10)}`);
  lines.push(`  Text: ${truncateText(item.text)}`);

  return lines.join("\n");
}

/**
 * Format tier counts for CLI output
 */
function formatTierCounts(tierCounts: TierCount[], totalCount: number): string {
  const lines: string[] = [];
  lines.push("Memory Counts by Tier:");
  lines.push("");

  for (const { tier, count } of tierCounts) {
    const bar = "█".repeat(Math.min(Math.ceil(count / 5), 20));
    const percentage = totalCount > 0 ? ((count / totalCount) * 100).toFixed(1) : "0.0";
    lines.push(`  ${tier.padEnd(8)} ${String(count).padStart(5)}  ${percentage.padStart(5)}%  ${bar}`);
  }

  lines.push("");
  lines.push(`Total: ${totalCount} memories`);

  return lines.join("\n");
}

/**
 * Format list items for CLI text output
 */
function formatTextOutput(result: ListCommandResult): string {
  const lines: string[] = [];

  // If no items (summary mode), show tier counts
  if (result.tierCounts && !result.items) {
    return formatTierCounts(result.tierCounts, result.totalCount);
  }

  // Filter header
  if (result.filter) {
    const filters: string[] = [];
    if (result.filter.tier) {
      filters.push(`Tier: ${result.filter.tier}`);
    }
    if (result.filter.forgotten) {
      filters.push("Forgotten: yes");
    }
    if (result.filter.pinned) {
      filters.push("Pinned: yes");
    }
    if (result.filter.sort) {
      filters.push(`Sorted by: ${result.filter.sort}`);
    }
    if (filters.length > 0) {
      lines.push(`Filters: ${filters.join(", ")}`);
    }
  }

  lines.push(`Found: ${result.totalCount} memories`);
  lines.push("");

  // Results
  if (!result.items || result.items.length === 0) {
    lines.push("No memories found matching the criteria.");
  } else {
    for (const item of result.items) {
      lines.push(formatItem(item));
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

/**
 * MemoryListCommand implements the CLI list functionality.
 */
export class MemoryListCommand {
  private db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  /**
   * Execute the list command
   * @param options - List options
   * @returns Formatted output string
   */
  async execute(options: ListOptions = {}): Promise<string> {
    // If no filters, show tier count summary
    const hasFilters = options.tier || options.forgotten || options.pinned;

    if (!hasFilters) {
      return this.executeSummary(options);
    }

    return this.executeFiltered(options);
  }

  /**
   * Execute summary mode - show counts by tier
   */
  private executeSummary(options: ListOptions): string {
    // Get counts by tier
    const stmt = this.db.prepare(`
      SELECT tier, COUNT(*) as count
      FROM memories
      GROUP BY tier
      ORDER BY
        CASE tier
          WHEN 'HOT' THEN 1
          WHEN 'WARM' THEN 2
          WHEN 'COLD' THEN 3
          WHEN 'ARCHIVE' THEN 4
        END
    `);

    const rows = stmt.all() as Array<{ tier: string; count: number }>;

    // Ensure all tiers are represented (even with 0 count)
    const tierOrder: Tier[] = [Tier.HOT, Tier.WARM, Tier.COLD, Tier.ARCHIVE];
    const countMap = new Map(rows.map((r) => [r.tier, r.count]));

    const tierCounts: TierCount[] = tierOrder.map((tier) => ({
      tier,
      count: countMap.get(tier) ?? 0,
    }));

    const totalCount = tierCounts.reduce((sum, tc) => sum + tc.count, 0);

    const result: ListCommandResult = {
      tierCounts,
      totalCount,
    };

    if (options.json) {
      return JSON.stringify(result, null, 2);
    }

    return formatTextOutput(result);
  }

  /**
   * Execute filtered mode - list memories matching criteria
   */
  private executeFiltered(options: ListOptions): string {
    const limit = options.limit ?? 20;
    const sort = options.sort ?? "created_at";

    // Build WHERE clause
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (options.tier) {
      conditions.push("tier = ?");
      params.push(options.tier);
    }

    if (options.forgotten) {
      conditions.push("do_not_inject = 1");
    }

    if (options.pinned) {
      conditions.push("pinned = 1");
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Map sort field
    const sortField = sort === "use_count" ? "use_count" : sort;
    const sortDirection = sort === "use_count" ? "DESC" : "DESC"; // Most recent/highest first

    // Query memories
    const stmt = this.db.prepare(`
      SELECT
        id, text, importance, category, created_at, tier, memory_type,
        do_not_inject, pinned, use_count, last_accessed_at, use_days, source, parent_id
      FROM memories
      ${whereClause}
      ORDER BY ${sortField} ${sortDirection}
      LIMIT ?
    `);

    const rows = stmt.all(...params, limit) as Array<{
      id: string;
      text: string;
      importance: number;
      category: string | null;
      created_at: string;
      tier: string;
      memory_type: string;
      do_not_inject: number;
      pinned: number;
      use_count: number;
      last_accessed_at: string;
      use_days: string;
      source: string | null;
      parent_id: string | null;
    }>;

    // Get total count for the filter
    const countStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM memories ${whereClause}
    `);
    const countRow = countStmt.get(...params) as { count: number };

    const items: ListItem[] = rows.map((row) => ({
      id: row.id,
      text: row.text,
      tier: row.tier as Tier,
      memoryType: row.memory_type as MemoryType,
      pinned: row.pinned === 1,
      forgotten: row.do_not_inject === 1,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
      useCount: row.use_count,
    }));

    const result: ListCommandResult = {
      totalCount: countRow.count,
      items,
      filter: {
        tier: options.tier,
        forgotten: options.forgotten,
        pinned: options.pinned,
        sort: options.sort,
      },
    };

    if (options.json) {
      return JSON.stringify(result, null, 2);
    }

    return formatTextOutput(result);
  }
}

export default MemoryListCommand;
