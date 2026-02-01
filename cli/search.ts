/**
 * CLI search command - Search memories from the command line.
 * Command: openclaw memory search <query>
 * Options: --deep (includes ARCHIVE), --tier <tier>, --limit <n>, --json, --explain
 */

import type { Database as SqliteDb } from "better-sqlite3";
import { Tier, MemoryType, type Memory } from "../core/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { VectorHelper } from "../db/vectors.js";
import { MemoryScorer, type ScoreBreakdown } from "../core/scorer.js";

/**
 * CLI search command options
 */
export interface SearchOptions {
  /** Include ARCHIVE tier memories */
  deep?: boolean;
  /** Filter by specific tier */
  tier?: "HOT" | "WARM" | "COLD" | "ARCHIVE";
  /** Maximum number of results (default: 10) */
  limit?: number;
  /** Output as JSON */
  json?: boolean;
  /** Show scoring breakdown for each result */
  explain?: boolean;
}

/**
 * Search result with metadata
 */
export interface SearchResult {
  /** Memory ID */
  id: string;
  /** Memory text (truncated for display) */
  text: string;
  /** Current tier */
  tier: Tier;
  /** Combined score */
  score: number;
  /** Whether the memory is pinned */
  pinned: boolean;
  /** Whether the memory is forgotten (do_not_inject) */
  forgotten: boolean;
  /** Memory type */
  memoryType: MemoryType;
  /** Scoring breakdown (only if explain=true) */
  breakdown?: ScoreBreakdown;
}

/**
 * Search command result
 */
export interface SearchCommandResult {
  /** Search query used */
  query: string;
  /** Total results found */
  count: number;
  /** Search results */
  results: SearchResult[];
  /** Whether deep search was used */
  deep: boolean;
  /** Tier filter applied */
  tierFilter?: string;
}

/**
 * Maximum text length for display (truncated with ellipsis)
 */
const MAX_TEXT_LENGTH = 80;

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
 * Format a single search result for CLI output
 */
function formatResult(result: SearchResult, explain: boolean): string {
  const lines: string[] = [];

  // Build tags
  const tags: string[] = [];
  if (result.pinned) {
    tags.push("[PINNED]");
  }
  if (result.forgotten) {
    tags.push("[FORGOTTEN]");
  }

  // Main result line
  const tagStr = tags.length > 0 ? ` ${tags.join(" ")}` : "";
  lines.push(`${result.id}`);
  lines.push(`  Tier: ${result.tier} | Score: ${result.score.toFixed(4)} | Type: ${result.memoryType}${tagStr}`);
  lines.push(`  Text: ${truncateText(result.text)}`);

  // Scoring breakdown if requested
  if (explain && result.breakdown) {
    lines.push("  Scoring Breakdown:");
    lines.push(`    Similarity: ${result.breakdown.similarityComponent.toFixed(4)}`);
    lines.push(`    Recency: ${result.breakdown.recencyComponent.toFixed(4)} (age: ${result.breakdown.effectiveAgeDays.toFixed(1)}d, half-life: ${result.breakdown.halfLifeDays}d)`);
    lines.push(`    Frequency: ${result.breakdown.frequencyComponent.toFixed(4)}`);
    lines.push(`    Total: ${result.breakdown.totalScore.toFixed(4)}`);
  }

  return lines.join("\n");
}

/**
 * Format search results for CLI text output
 */
function formatTextOutput(result: SearchCommandResult, explain: boolean): string {
  const lines: string[] = [];

  // Header
  lines.push(`Search results for: "${result.query}"`);
  if (result.tierFilter) {
    lines.push(`Tier filter: ${result.tierFilter}`);
  }
  if (result.deep) {
    lines.push("(includes ARCHIVE tier)");
  }
  lines.push(`Found: ${result.count} result(s)`);
  lines.push("");

  // Results
  if (result.results.length === 0) {
    lines.push("No memories found matching the query.");
  } else {
    for (const item of result.results) {
      lines.push(formatResult(item, explain));
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

/**
 * MemorySearchCommand implements the CLI search functionality.
 */
export class MemorySearchCommand {
  private db: SqliteDb;
  private embeddingProvider: EmbeddingProvider;
  private vectorHelper: VectorHelper;
  private scorer: MemoryScorer;

  constructor(
    db: SqliteDb,
    embeddingProvider: EmbeddingProvider,
    vectorHelper: VectorHelper,
    scorer?: MemoryScorer
  ) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    this.vectorHelper = vectorHelper;
    this.scorer = scorer ?? new MemoryScorer();
  }

  /**
   * Execute the search command
   * @param query - The search query string
   * @param options - Search options
   * @returns Formatted output string
   */
  async execute(query: string, options: SearchOptions = {}): Promise<string> {
    // Validate query
    if (!query || typeof query !== "string") {
      throw new Error("Search query is required");
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      throw new Error("Search query cannot be empty");
    }

    const limit = options.limit ?? 10;
    const includeArchive = options.deep ?? false;
    const explain = options.explain ?? false;

    // Generate embedding for the query
    const queryEmbedding = await this.embeddingProvider.embed(trimmedQuery);

    // Perform hybrid search with extra candidates
    const candidateLimit = Math.max(limit * 3, 30);
    const hybridResults = this.vectorHelper.hybridSearch(
      trimmedQuery,
      queryEmbedding,
      { limit: candidateLimit }
    );

    // Fetch full memory details
    const candidateIds = hybridResults.map((r) => r.id);
    const memories = this.fetchMemories(candidateIds);

    // Filter by tier if specified
    let filteredMemories = memories;
    if (options.tier) {
      filteredMemories = filteredMemories.filter(
        (m) => m.tier === options.tier
      );
    }

    // Filter out ARCHIVE unless deep search
    if (!includeArchive) {
      filteredMemories = filteredMemories.filter(
        (m) => m.tier !== Tier.ARCHIVE
      );
    }

    // Create map of hybrid scores
    const hybridScoreMap = new Map(
      hybridResults.map((r) => [r.id, r.vectorScore])
    );

    // Score and rank memories
    const now = new Date();
    const scoredResults: SearchResult[] = filteredMemories.map((memory) => {
      const similarity = hybridScoreMap.get(memory.id) ?? 0;
      const breakdown = this.scorer.scoreWithBreakdown(memory, similarity, now);

      return {
        id: memory.id,
        text: memory.text,
        tier: memory.tier,
        score: breakdown.totalScore,
        pinned: memory.pinned,
        forgotten: memory.do_not_inject,
        memoryType: memory.memory_type,
        breakdown: explain ? breakdown : undefined,
      };
    });

    // Sort by score descending
    scoredResults.sort((a, b) => b.score - a.score);

    // Apply limit
    const limitedResults = scoredResults.slice(0, limit);

    // Build result object
    const commandResult: SearchCommandResult = {
      query: trimmedQuery,
      count: limitedResults.length,
      results: limitedResults,
      deep: includeArchive,
      tierFilter: options.tier,
    };

    // Format output
    if (options.json) {
      return JSON.stringify(commandResult, null, 2);
    }

    return formatTextOutput(commandResult, explain);
  }

  /**
   * Fetch full memory records by IDs
   */
  private fetchMemories(ids: string[]): Memory[] {
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => "?").join(", ");
    const stmt = this.db.prepare(`
      SELECT
        id, text, importance, category, created_at, tier, memory_type,
        do_not_inject, pinned, use_count, last_accessed_at, use_days, source, parent_id
      FROM memories
      WHERE id IN (${placeholders})
    `);

    const rows = stmt.all(...ids) as Array<{
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

    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      importance: row.importance,
      category: row.category,
      created_at: row.created_at,
      tier: row.tier as Tier,
      memory_type: row.memory_type as MemoryType,
      do_not_inject: row.do_not_inject === 1,
      pinned: row.pinned === 1,
      use_count: row.use_count,
      last_accessed_at: row.last_accessed_at,
      use_days: JSON.parse(row.use_days || "[]"),
      source: row.source,
      parent_id: row.parent_id,
    }));
  }
}

export default MemorySearchCommand;
