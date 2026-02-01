/**
 * memory_explain tool - Explain how a memory is scored and its injection eligibility.
 * Provides detailed breakdown of scoring components and eligibility reasoning.
 */

import type { Database as SqliteDb } from "better-sqlite3";
import { Tier, MemoryType, type Memory } from "../core/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { VectorHelper } from "../db/vectors.js";
import { MemoryScorer, type ScoreBreakdown, HALF_LIVES } from "../core/scorer.js";

/**
 * UUID regex pattern for validation
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Input parameters for the memory_explain tool
 */
export interface MemoryExplainInput {
  /** Memory ID to explain (required) */
  memoryId: string;
  /** Optional query for similarity calculation */
  query?: string;
}

/**
 * Injection eligibility details
 */
export interface InjectionEligibility {
  /** Whether the memory is eligible for injection */
  eligible: boolean;
  /** Reason for eligibility status */
  reason: string;
  /** Whether the memory is pinned (priority injection) */
  isPinned: boolean;
  /** Whether the memory is forgotten (do_not_inject) */
  isForgotten: boolean;
  /** Current tier */
  tier: Tier;
}

/**
 * Detailed scoring breakdown for explanation
 */
export interface ScoringExplanation {
  /** Raw similarity value (0-1) */
  similarityValue: number;
  /** Similarity component after weighting */
  similarityComponent: number;
  /** Recency component after weighting */
  recencyComponent: number;
  /** Frequency component after weighting */
  frequencyComponent: number;
  /** Total combined score */
  totalScore: number;
  /** Effective age in days */
  effectiveAgeDays: number;
  /** Half-life used for this memory type */
  halfLifeDays: number;
}

/**
 * Full explanation details for a memory
 */
export interface MemoryExplanationDetails {
  /** Memory ID */
  id: string;
  /** Full text content */
  text: string;
  /** Current tier */
  tier: Tier;
  /** Memory type */
  memoryType: MemoryType;
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
  scoring: ScoringExplanation;
  /** Injection eligibility */
  injection: InjectionEligibility;
}

/**
 * Result from the memory_explain tool
 */
export interface MemoryExplainResult {
  /** Response content for the agent */
  content: Array<{ type: "text"; text: string }>;
  /** Full explanation details */
  details: MemoryExplanationDetails;
}

/**
 * MemoryExplainTool provides the memory_explain tool implementation.
 * Explains how a memory is scored and whether it's eligible for injection.
 */
export class MemoryExplainTool {
  private db: SqliteDb;
  private embeddingProvider: EmbeddingProvider | null;
  private vectorHelper: VectorHelper | null;
  private scorer: MemoryScorer;

  /**
   * Create a new MemoryExplainTool instance.
   * @param db - The better-sqlite3 database instance
   * @param embeddingProvider - Optional provider for similarity calculation
   * @param vectorHelper - Optional helper for vector similarity
   * @param scorer - Optional scorer instance (creates default if not provided)
   */
  constructor(
    db: SqliteDb,
    embeddingProvider?: EmbeddingProvider,
    vectorHelper?: VectorHelper,
    scorer?: MemoryScorer
  ) {
    this.db = db;
    this.embeddingProvider = embeddingProvider ?? null;
    this.vectorHelper = vectorHelper ?? null;
    this.scorer = scorer ?? new MemoryScorer();
  }

  /**
   * Explain how a memory is scored and its injection eligibility.
   * @param input - The memory explain parameters
   * @returns The result containing explanation details
   */
  async execute(input: MemoryExplainInput): Promise<MemoryExplainResult> {
    // Validate required input
    if (!input.memoryId || typeof input.memoryId !== "string") {
      throw new Error("Missing required parameter: memoryId");
    }

    const memoryId = input.memoryId.trim();

    // Validate UUID format
    if (!UUID_REGEX.test(memoryId)) {
      throw new Error(`Invalid memory ID format: ${memoryId}`);
    }

    // Fetch the memory
    const memory = this.fetchMemory(memoryId);
    if (!memory) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    // Calculate similarity if query is provided and providers are available
    let similarity = 1; // Default when no query
    if (input.query && this.embeddingProvider && this.vectorHelper) {
      similarity = await this.calculateSimilarity(memory.id, input.query);
    }

    // Get scoring breakdown
    const now = new Date();
    const breakdown = this.scorer.scoreWithBreakdown(memory, similarity, now);

    // Determine injection eligibility
    const injection = this.determineInjectionEligibility(memory);

    // Build explanation details
    const details: MemoryExplanationDetails = {
      id: memory.id,
      text: memory.text,
      tier: memory.tier,
      memoryType: memory.memory_type,
      createdAt: memory.created_at,
      lastAccessedAt: memory.last_accessed_at,
      effectiveAgeDays: breakdown.effectiveAgeDays,
      useCount: memory.use_count,
      useDays: memory.use_days,
      scoring: {
        similarityValue: similarity,
        similarityComponent: breakdown.similarityComponent,
        recencyComponent: breakdown.recencyComponent,
        frequencyComponent: breakdown.frequencyComponent,
        totalScore: breakdown.totalScore,
        effectiveAgeDays: breakdown.effectiveAgeDays,
        halfLifeDays: breakdown.halfLifeDays,
      },
      injection,
    };

    // Build response text
    const responseText = this.formatExplanationText(details);

    return {
      content: [{ type: "text", text: responseText }],
      details,
    };
  }

  /**
   * Fetch a memory by ID.
   */
  private fetchMemory(memoryId: string): Memory | null {
    const stmt = this.db.prepare(`
      SELECT
        id, text, importance, category, created_at, tier, memory_type,
        do_not_inject, pinned, use_count, last_accessed_at, use_days, source, parent_id
      FROM memories
      WHERE id = ?
    `);

    const row = stmt.get(memoryId) as
      | {
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
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
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
    };
  }

  /**
   * Calculate similarity between a memory and a query.
   */
  private async calculateSimilarity(
    memoryId: string,
    query: string
  ): Promise<number> {
    if (!this.embeddingProvider || !this.vectorHelper) {
      return 1; // Default when no providers
    }

    // Generate query embedding
    const queryEmbedding = await this.embeddingProvider.embed(query);

    // Search for similarity with the specific memory
    const results = this.vectorHelper.vectorSearch(queryEmbedding, 100);

    // Find this memory's similarity in the results
    const memoryResult = results.find((r) => r.id === memoryId);
    return memoryResult?.similarity ?? 0;
  }

  /**
   * Determine injection eligibility for a memory.
   */
  private determineInjectionEligibility(memory: Memory): InjectionEligibility {
    const isPinned = memory.pinned;
    const isForgotten = memory.do_not_inject;
    const tier = memory.tier;

    let eligible = true;
    let reason = "Eligible for injection";

    // Check disqualifying conditions
    if (isForgotten) {
      eligible = false;
      reason = "Excluded from injection (do_not_inject is set)";
    } else if (tier === Tier.ARCHIVE) {
      eligible = false;
      reason = "ARCHIVE tier memories are never auto-injected";
    } else if (isPinned) {
      eligible = true;
      reason = "Pinned memory - priority injection (25% budget)";
    } else if (tier === Tier.HOT) {
      reason = "HOT tier - high priority injection (45% budget)";
    } else if (tier === Tier.WARM) {
      reason = "WARM tier - moderate priority injection (25% budget)";
    } else if (tier === Tier.COLD) {
      reason = "COLD tier - low priority injection (5% budget)";
    }

    return {
      eligible,
      reason,
      isPinned,
      isForgotten,
      tier,
    };
  }

  /**
   * Format a human-readable explanation text.
   */
  private formatExplanationText(details: MemoryExplanationDetails): string {
    const lines: string[] = [
      `Memory Explanation: ${details.id}`,
      "",
      `Tier: ${details.tier}`,
      `Type: ${details.memoryType} (half-life: ${details.scoring.halfLifeDays} days)`,
      "",
      `Created: ${details.createdAt}`,
      `Last Accessed: ${details.lastAccessedAt}`,
      `Effective Age: ${details.effectiveAgeDays.toFixed(2)} days`,
      "",
      `Use Count: ${details.useCount}`,
      `Use Days: ${details.useDays.length} distinct days`,
      "",
      "Scoring Breakdown:",
      `  Similarity: ${details.scoring.similarityValue.toFixed(4)} → component: ${details.scoring.similarityComponent.toFixed(4)}`,
      `  Recency: exp(-${details.scoring.effectiveAgeDays.toFixed(2)}/${details.scoring.halfLifeDays}) → component: ${details.scoring.recencyComponent.toFixed(4)}`,
      `  Frequency: log(1+${details.useCount}) → component: ${details.scoring.frequencyComponent.toFixed(4)}`,
      `  Total Score: ${details.scoring.totalScore.toFixed(4)}`,
      "",
      "Injection Eligibility:",
      `  Eligible: ${details.injection.eligible ? "Yes" : "No"}`,
      `  Reason: ${details.injection.reason}`,
    ];

    if (details.injection.isPinned) {
      lines.push("  Pinned: Yes (bypasses decay)");
    }
    if (details.injection.isForgotten) {
      lines.push("  Forgotten: Yes (soft-deleted)");
    }

    return lines.join("\n");
  }
}

export default MemoryExplainTool;
