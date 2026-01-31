/**
 * Auto-recall hook for before_agent_start event.
 * Automatically injects relevant memories into agent context based on the prompt.
 */

import type { Database as SqliteDb } from "better-sqlite3";
import type { Memory, Tier } from "../core/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { VectorHelper } from "../db/vectors.js";
import { MemoryScorer } from "../core/scorer.js";
import {
  TierBudgetAllocator,
  type ScoredMemory,
} from "../core/injection.js";
import { MemorySetContextTool } from "../tools/memory_set_context.js";
import type { ResolvedConfig } from "../config.js";

/**
 * Result from the auto-recall hook
 */
export interface AutoRecallResult {
  /** Context to prepend to agent prompt */
  prependContext?: string;
  /** Number of memories injected */
  memoriesInjected: number;
  /** Whether current context was included */
  contextIncluded: boolean;
}

/**
 * Configuration for the auto-recall hook
 */
export interface AutoRecallConfig {
  /** Whether auto-recall is enabled (default: true) */
  enabled: boolean;
  /** Maximum items to inject */
  maxItems: number;
  /** Budget percentages for tier allocation */
  budgets: {
    pinned: number;
    hot: number;
    warm: number;
    cold: number;
  };
  /** Scoring weights */
  scoringWeights: {
    similarity: number;
    recency: number;
    frequency: number;
  };
}

/**
 * AutoRecallHook provides automatic memory injection for agent context.
 * Registered as a before_agent_start hook to prepend relevant memories.
 */
export class AutoRecallHook {
  private db: SqliteDb;
  private embeddingProvider: EmbeddingProvider;
  private vectorHelper: VectorHelper;
  private scorer: MemoryScorer;
  private allocator: TierBudgetAllocator;
  private contextTool: MemorySetContextTool;
  private config: AutoRecallConfig;

  /**
   * Create a new AutoRecallHook instance.
   * @param db - The better-sqlite3 database instance
   * @param embeddingProvider - Provider for generating embeddings
   * @param vectorHelper - Helper for vector storage and search
   * @param config - Auto-recall configuration
   */
  constructor(
    db: SqliteDb,
    embeddingProvider: EmbeddingProvider,
    vectorHelper: VectorHelper,
    config: Partial<AutoRecallConfig> = {}
  ) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    this.vectorHelper = vectorHelper;

    // Merge with defaults
    this.config = {
      enabled: config.enabled ?? true,
      maxItems: config.maxItems ?? 20,
      budgets: {
        pinned: config.budgets?.pinned ?? 25,
        hot: config.budgets?.hot ?? 45,
        warm: config.budgets?.warm ?? 25,
        cold: config.budgets?.cold ?? 5,
      },
      scoringWeights: {
        similarity: config.scoringWeights?.similarity ?? 0.5,
        recency: config.scoringWeights?.recency ?? 0.3,
        frequency: config.scoringWeights?.frequency ?? 0.2,
      },
    };

    // Initialize scorer with configured weights
    this.scorer = new MemoryScorer({
      similarity: this.config.scoringWeights.similarity,
      recency: this.config.scoringWeights.recency,
      frequency: this.config.scoringWeights.frequency,
    });

    // Initialize allocator with configured budgets (convert percentages to decimals)
    this.allocator = new TierBudgetAllocator(
      {
        maxItems: this.config.maxItems,
        budgets: {
          pinned: this.config.budgets.pinned / 100,
          hot: this.config.budgets.hot / 100,
          warm: this.config.budgets.warm / 100,
          cold: this.config.budgets.cold / 100,
        },
      },
      this.scorer
    );

    // Initialize context tool for retrieving current context
    this.contextTool = new MemorySetContextTool(db);
  }

  /**
   * Execute the auto-recall hook before agent start.
   * @param prompt - The user prompt to extract key terms from
   * @returns Hook result with prepended context
   */
  async execute(prompt: string): Promise<AutoRecallResult> {
    // Check if auto-recall is enabled
    if (!this.config.enabled) {
      return {
        memoriesInjected: 0,
        contextIncluded: false,
      };
    }

    // Check for empty prompt
    if (!prompt || prompt.trim().length === 0) {
      return {
        memoriesInjected: 0,
        contextIncluded: false,
      };
    }

    // Extract key terms from the prompt for search
    const keyTerms = this.extractKeyTerms(prompt);

    // If no meaningful terms, try using the whole prompt (trimmed)
    const searchQuery = keyTerms.length > 0 ? keyTerms.join(" ") : prompt.trim();

    // Generate embedding for the search query
    const queryEmbedding = await this.embeddingProvider.embed(searchQuery);

    // Perform hybrid search to find relevant memories
    const candidateLimit = Math.max(this.config.maxItems * 3, 30);
    const hybridResults = this.vectorHelper.hybridSearch(
      searchQuery,
      queryEmbedding,
      { limit: candidateLimit }
    );

    // If no results found, still check for current context
    if (hybridResults.length === 0) {
      const currentContext = this.contextTool.getContext();
      if (currentContext) {
        const formatted = this.formatMemoriesAsXml([], currentContext.text);
        return {
          prependContext: formatted,
          memoriesInjected: 0,
          contextIncluded: true,
        };
      }
      return {
        memoriesInjected: 0,
        contextIncluded: false,
      };
    }

    // Fetch full memory records for scoring
    const candidateIds = hybridResults.map((r) => r.id);
    const memories = this.fetchMemories(candidateIds);

    // Create similarity map for scoring
    const similarityMap = new Map<string, number>();
    for (const result of hybridResults) {
      similarityMap.set(result.id, result.vectorScore);
    }

    // Apply tier budget allocation to select memories
    const allocation = this.allocator.allocate(memories, similarityMap);

    // Update access stats for selected memories
    const now = new Date();
    const today = now.toISOString().split("T")[0]; // YYYY-MM-DD

    for (const { memory } of allocation.selected) {
      this.updateAccessStats(memory.id, now.toISOString(), today);
    }

    // Get current context if not expired
    const currentContext = this.contextTool.getContext();
    const contextText = currentContext?.text ?? null;

    // Format memories as XML
    const selectedMemories = allocation.selected.map((sm) => sm.memory);
    const formattedXml = this.formatMemoriesAsXml(selectedMemories, contextText);

    return {
      prependContext: formattedXml,
      memoriesInjected: allocation.selected.length,
      contextIncluded: currentContext !== null,
    };
  }

  /**
   * Extract key terms from a prompt for search.
   * Removes common stop words and short terms.
   * @param prompt - The user prompt
   * @returns Array of key terms
   */
  private extractKeyTerms(prompt: string): string[] {
    // Common English stop words to filter out
    const stopWords = new Set([
      "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "must", "shall", "can", "need", "dare",
      "ought", "used", "to", "of", "in", "for", "on", "with", "at", "by",
      "from", "up", "about", "into", "through", "during", "before", "after",
      "above", "below", "between", "under", "again", "further", "then",
      "once", "here", "there", "when", "where", "why", "how", "all", "each",
      "few", "more", "most", "other", "some", "such", "no", "nor", "not",
      "only", "own", "same", "so", "than", "too", "very", "just", "and",
      "but", "if", "or", "because", "as", "until", "while", "although",
      "though", "since", "unless", "i", "me", "my", "myself", "we", "our",
      "ours", "ourselves", "you", "your", "yours", "yourself", "yourselves",
      "he", "him", "his", "himself", "she", "her", "hers", "herself", "it",
      "its", "itself", "they", "them", "their", "theirs", "themselves",
      "what", "which", "who", "whom", "this", "that", "these", "those",
      "am", "please", "help", "want", "like", "know", "think", "get",
      "make", "go", "see", "come", "take", "use", "find", "give", "tell",
      "say", "ask", "work", "try", "call", "put", "let", "look", "run",
    ]);

    // Tokenize: split on whitespace and punctuation
    const tokens = prompt
      .toLowerCase()
      .split(/[\s\-_.,!?;:"'()\[\]{}]+/)
      .filter((token) => token.length > 2) // Remove very short tokens
      .filter((token) => !stopWords.has(token)) // Remove stop words
      .filter((token) => !/^\d+$/.test(token)); // Remove pure numbers

    // Deduplicate while preserving order
    const seen = new Set<string>();
    const uniqueTerms: string[] = [];
    for (const token of tokens) {
      if (!seen.has(token)) {
        seen.add(token);
        uniqueTerms.push(token);
      }
    }

    // Return top terms (limit to prevent query explosion)
    return uniqueTerms.slice(0, 20);
  }

  /**
   * Format memories and current context as XML for injection.
   * @param memories - Selected memories to format
   * @param contextText - Current context text (or null)
   * @returns Formatted XML string
   */
  private formatMemoriesAsXml(
    memories: Memory[],
    contextText: string | null
  ): string {
    const lines: string[] = [];
    lines.push("<relevant-memories>");

    // Add current context first if present
    if (contextText) {
      lines.push("  <current-context>");
      lines.push(`    ${this.escapeXml(contextText)}`);
      lines.push("  </current-context>");
    }

    // Add each memory
    for (const memory of memories) {
      lines.push(`  <memory id="${memory.id}" tier="${memory.tier}" type="${memory.memory_type}"${memory.pinned ? ' pinned="true"' : ""}>`);
      lines.push(`    ${this.escapeXml(memory.text)}`);
      lines.push("  </memory>");
    }

    lines.push("</relevant-memories>");

    return lines.join("\n");
  }

  /**
   * Escape special XML characters in text.
   * @param text - Text to escape
   * @returns Escaped text
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
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
      memory_type: row.memory_type as import("../core/types.js").MemoryType,
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
  }

  /**
   * Check if auto-recall is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Enable or disable auto-recall.
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): AutoRecallConfig {
    return { ...this.config };
  }
}

/**
 * Create an AutoRecallHook from resolved plugin config.
 * @param db - Database instance
 * @param embeddingProvider - Embedding provider
 * @param vectorHelper - Vector helper
 * @param config - Resolved plugin configuration
 * @returns Configured AutoRecallHook instance
 */
export function createAutoRecallHook(
  db: SqliteDb,
  embeddingProvider: EmbeddingProvider,
  vectorHelper: VectorHelper,
  config: ResolvedConfig
): AutoRecallHook {
  return new AutoRecallHook(db, embeddingProvider, vectorHelper, {
    enabled: config.autoRecall,
    maxItems: config.injection.maxItems,
    budgets: config.injection.budgets,
    scoringWeights: {
      similarity: config.scoring.similarity,
      recency: config.scoring.recency,
      frequency: config.scoring.frequency,
    },
  });
}

export default AutoRecallHook;
