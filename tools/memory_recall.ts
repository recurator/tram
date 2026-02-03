/**
 * memory_recall tool - Search and retrieve memories from the tiered memory system.
 * Handles hybrid search (FTS + vector), scoring, and access stat updates.
 */

import type { Database as SqliteDb } from "better-sqlite3";
import { Tier, MemoryType, type Memory } from "../core/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { VectorHelper } from "../db/vectors.js";
import { MemoryScorer } from "../core/scorer.js";

/**
 * Input parameters for the memory_recall tool
 */
export interface MemoryRecallInput {
  /** Search query text (required) */
  query: string;
  /** Maximum number of results (default: 5) */
  limit?: number;
  /** Filter by tier */
  tier?: "HOT" | "WARM" | "COLD" | "ARCHIVE";
  /** Include ARCHIVE tier memories (default: false) */
  includeArchive?: boolean;
  /** Include forgotten (do_not_inject) memories (default: false) */
  includeForgotten?: boolean;
}

/**
 * A single memory recall result
 */
export interface RecalledMemory {
  /** Memory ID */
  id: string;
  /** Memory text content */
  text: string;
  /** Current tier */
  tier: Tier;
  /** Type of memory */
  memory_type: MemoryType;
  /** Combined relevance score */
  score: number;
  /** Whether the memory is pinned */
  pinned: boolean;
  /** Whether the memory is forgotten (do_not_inject) */
  forgotten: boolean;
}

/**
 * Result from the memory_recall tool
 */
export interface MemoryRecallResult {
  /** Response content for the agent */
  content: Array<{ type: "text"; text: string }>;
  /** List of recalled memories */
  memories: RecalledMemory[];
}

/**
 * MemoryRecallTool provides the memory_recall tool implementation.
 * Searches and retrieves memories with hybrid search and composite scoring.
 */
export class MemoryRecallTool {
  private db: SqliteDb;
  private embeddingProvider: EmbeddingProvider;
  private vectorHelper: VectorHelper;
  private scorer: MemoryScorer;

  /**
   * Create a new MemoryRecallTool instance.
   * @param db - The better-sqlite3 database instance
   * @param embeddingProvider - Provider for generating embeddings
   * @param vectorHelper - Helper for vector storage and search
   * @param scorer - Optional scorer instance (creates default if not provided)
   */
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
   * Search and retrieve memories from the tiered memory system.
   * @param input - The memory recall parameters
   * @returns The result containing recalled memories
   */
  async execute(input: MemoryRecallInput): Promise<MemoryRecallResult> {
    // Validate required input
    if (!input.query || typeof input.query !== "string") {
      throw new Error("Missing required parameter: query");
    }

    const query = input.query.trim();
    if (query.length === 0) {
      throw new Error("Query cannot be empty");
    }

    const limit = input.limit ?? 5;
    const includeArchive = input.includeArchive ?? false;
    const includeForgotten = input.includeForgotten ?? false;

    // Generate embedding for the query
    const queryEmbedding = await this.embeddingProvider.embed(query);

    // Perform hybrid search with extra candidates for filtering
    const candidateLimit = Math.max(limit * 3, 30);
    const hybridResults = this.vectorHelper.hybridSearch(
      query,
      queryEmbedding,
      { limit: candidateLimit }
    );

    // Fetch full memory details for candidates
    const candidateIds = hybridResults.map((r) => r.id);
    const memories = this.fetchMemories(candidateIds);

    // Filter by tier if specified
    let filteredMemories = memories;
    if (input.tier) {
      filteredMemories = filteredMemories.filter(
        (m) => m.tier === input.tier
      );
    }

    // Filter out ARCHIVE unless requested
    if (!includeArchive) {
      filteredMemories = filteredMemories.filter(
        (m) => m.tier !== Tier.ARCHIVE
      );
    }

    // Filter out forgotten unless requested
    if (!includeForgotten) {
      filteredMemories = filteredMemories.filter(
        (m) => !m.do_not_inject
      );
    }

    // Create a map of hybrid scores by ID
    const hybridScoreMap = new Map(
      hybridResults.map((r) => [r.id, r.vectorScore])
    );

    // Score and rank filtered memories
    const scoredMemories = filteredMemories.map((memory) => {
      const similarity = hybridScoreMap.get(memory.id) ?? 0;
      const score = this.scorer.score(memory, similarity);
      return { memory, score };
    });

    // Sort by score descending
    scoredMemories.sort((a, b) => b.score - a.score);

    // Take top results up to limit
    const topResults = scoredMemories.slice(0, limit);

    // Update access stats for retrieved memories
    const now = new Date();
    const today = now.toISOString().split("T")[0]; // YYYY-MM-DD

    for (const { memory } of topResults) {
      this.updateAccessStats(memory.id, now.toISOString(), today);
    }

    // Format results
    const recalledMemories: RecalledMemory[] = topResults.map(({ memory, score }) => ({
      id: memory.id,
      text: memory.text,
      tier: memory.tier,
      memory_type: memory.memory_type,
      score,
      pinned: memory.pinned,
      forgotten: memory.do_not_inject,
    }));

    // Build response text
    const resultCount = recalledMemories.length;
    const responseText =
      resultCount === 0
        ? `No memories found matching "${query}".`
        : `Found ${resultCount} ${resultCount === 1 ? "memory" : "memories"} matching "${query}".`;

    return {
      content: [{ type: "text", text: responseText }],
      memories: recalledMemories,
    };
  }

  /**
   * Fetch full memory records by IDs.
   * @param ids - Array of memory IDs to fetch
   * @returns Array of Memory objects
   */
  private fetchMemories(ids: string[]): Memory[] {
    if (ids.length === 0) {
      return [];
    }

    // Build parameterized query for IN clause
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

  /**
   * Update access statistics for a memory.
   * Increments use_count, updates last_accessed_at, and adds today to use_days if not present.
   * Also updates access_frequency in injection_feedback if the memory was auto-injected.
   * @param memoryId - The memory ID
   * @param lastAccessedAt - ISO timestamp of access
   * @param today - Today's date in YYYY-MM-DD format
   */
  private updateAccessStats(
    memoryId: string,
    lastAccessedAt: string,
    today: string
  ): void {
    // Fetch current use_days
    const fetchStmt = this.db.prepare(`
      SELECT use_days FROM memories WHERE id = ?
    `);
    const row = fetchStmt.get(memoryId) as { use_days: string } | undefined;

    if (!row) {
      return; // Memory not found, skip
    }

    // Parse current use_days and add today if not present
    const useDays: string[] = JSON.parse(row.use_days || "[]");
    if (!useDays.includes(today)) {
      useDays.push(today);
    }

    // Update the memory record
    const updateStmt = this.db.prepare(`
      UPDATE memories
      SET use_count = use_count + 1,
          last_accessed_at = ?,
          use_days = ?
      WHERE id = ?
    `);

    updateStmt.run(lastAccessedAt, JSON.stringify(useDays), memoryId);

    // Update access_frequency in injection_feedback for the most recent injection
    this.updateInjectionFeedbackAccessFrequency(memoryId);
  }

  /**
   * Increment access_frequency for the most recent injection_feedback entry for a memory.
   * If no feedback entry exists, skip (memory wasn't auto-injected).
   * @param memoryId - The memory ID
   */
  private updateInjectionFeedbackAccessFrequency(memoryId: string): void {
    // Find the most recent injection_feedback entry by memory_id + injected_at
    const findStmt = this.db.prepare(`
      SELECT id FROM injection_feedback
      WHERE memory_id = ?
      ORDER BY injected_at DESC
      LIMIT 1
    `);

    const feedbackRow = findStmt.get(memoryId) as { id: string } | undefined;

    if (!feedbackRow) {
      return; // No feedback entry exists, memory wasn't auto-injected
    }

    // Increment access_frequency
    const updateStmt = this.db.prepare(`
      UPDATE injection_feedback
      SET access_frequency = access_frequency + 1
      WHERE id = ?
    `);

    updateStmt.run(feedbackRow.id);
  }
}

export default MemoryRecallTool;
