/**
 * Auto-recall hook handler for agent:bootstrap event.
 * Injects relevant memories into agent context via bootstrapFiles.
 */

import type { Database as SqliteDb } from "better-sqlite3";
import type { Memory, Tier } from "../../core/types.js";
import type { EmbeddingProvider } from "../../embeddings/provider.js";
import { VectorHelper } from "../../db/vectors.js";
import { MemoryScorer } from "../../core/scorer.js";
import { TierBudgetAllocator } from "../../core/injection.js";
import { MemorySetContextTool } from "../../tools/memory_set_context.js";
import type { ResolvedConfig } from "../../config.js";

/**
 * OpenClaw hook event interface
 */
export interface HookEvent {
  type: string;
  action?: string;
  sessionKey?: string;
  timestamp?: string;
  messages?: Array<{
    role: string;
    content?: string | Array<{ type: string; text?: string }>;
  }>;
  context?: {
    bootstrapFiles?: Array<{ path: string; content: string }>;
    workspace?: string;
    session?: unknown;
  };
}

/**
 * Hook handler type
 */
export type HookHandler = (event: HookEvent) => Promise<void> | void;

// Module-level state (initialized by plugin registration)
let db: SqliteDb | null = null;
let embeddingProvider: EmbeddingProvider | null = null;
let vectorHelper: VectorHelper | null = null;
let config: ResolvedConfig | null = null;
let scorer: MemoryScorer | null = null;
let allocator: TierBudgetAllocator | null = null;
let contextTool: MemorySetContextTool | null = null;

/**
 * Initialize the hook with required dependencies.
 * Called by the plugin during registration.
 */
export function initAutoRecallHook(
  database: SqliteDb,
  embedding: EmbeddingProvider,
  vectors: VectorHelper,
  pluginConfig: ResolvedConfig
): void {
  db = database;
  embeddingProvider = embedding;
  vectorHelper = vectors;
  config = pluginConfig;

  // Initialize scorer with configured weights
  scorer = new MemoryScorer({
    similarity: config.scoring.similarity,
    recency: config.scoring.recency,
    frequency: config.scoring.frequency,
  });

  // Initialize allocator with configured budgets
  allocator = new TierBudgetAllocator(
    {
      maxItems: config.injection.maxItems,
      budgets: {
        pinned: config.injection.budgets.pinned / 100,
        hot: config.injection.budgets.hot / 100,
        warm: config.injection.budgets.warm / 100,
        cold: config.injection.budgets.cold / 100,
      },
    },
    scorer
  );

  contextTool = new MemorySetContextTool(database);
}

/**
 * Extract the current prompt from hook event messages.
 */
function extractPrompt(event: HookEvent): string | null {
  if (!event.messages || event.messages.length === 0) {
    return null;
  }

  // Find the last user message
  for (let i = event.messages.length - 1; i >= 0; i--) {
    const msg = event.messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        return msg.content;
      }
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("\n");
      }
    }
  }

  return null;
}

/**
 * Extract key terms from a prompt for search.
 */
function extractKeyTerms(prompt: string): string[] {
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

  const tokens = prompt
    .toLowerCase()
    .split(/[\s\-_.,!?;:"'()\[\]{}]+/)
    .filter((token) => token.length > 2)
    .filter((token) => !stopWords.has(token))
    .filter((token) => !/^\d+$/.test(token));

  const seen = new Set<string>();
  const uniqueTerms: string[] = [];
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      uniqueTerms.push(token);
    }
  }

  return uniqueTerms.slice(0, 20);
}

/**
 * Escape special XML characters.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Format memories as XML for injection.
 */
function formatMemoriesAsXml(memories: Memory[], contextText: string | null): string {
  const lines: string[] = [];
  lines.push("<relevant-memories>");

  if (contextText) {
    lines.push("  <current-context>");
    lines.push(`    ${escapeXml(contextText)}`);
    lines.push("  </current-context>");
  }

  for (const memory of memories) {
    lines.push(`  <memory id="${memory.id}" tier="${memory.tier}" type="${memory.memory_type}"${memory.pinned ? ' pinned="true"' : ""}>`);
    lines.push(`    ${escapeXml(memory.text)}`);
    lines.push("  </memory>");
  }

  lines.push("</relevant-memories>");
  return lines.join("\n");
}

/**
 * Fetch full memory records by IDs.
 */
function fetchMemories(ids: string[]): Memory[] {
  if (!db || ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => "?").join(", ");
  const stmt = db.prepare(`
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
    memory_type: row.memory_type as import("../../core/types.js").MemoryType,
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
 */
function updateAccessStats(memoryId: string, lastAccessedAt: string, today: string): void {
  if (!db) return;

  const fetchStmt = db.prepare(`SELECT use_days FROM memories WHERE id = ?`);
  const row = fetchStmt.get(memoryId) as { use_days: string } | undefined;
  if (!row) return;

  const useDays: string[] = JSON.parse(row.use_days || "[]");
  if (!useDays.includes(today)) {
    useDays.push(today);
  }

  const updateStmt = db.prepare(`
    UPDATE memories
    SET use_count = use_count + 1,
        last_accessed_at = ?,
        use_days = ?
    WHERE id = ?
  `);
  updateStmt.run(lastAccessedAt, JSON.stringify(useDays), memoryId);
}

/**
 * Hook handler for agent:bootstrap event.
 * Injects relevant memories into context.bootstrapFiles.
 */
export const handler: HookHandler = async (event: HookEvent) => {
  // Only handle agent:bootstrap events
  if (event.type !== "agent:bootstrap") {
    return;
  }

  // Check if initialized and enabled
  if (!db || !embeddingProvider || !vectorHelper || !config || !scorer || !allocator || !contextTool) {
    console.error("[TRAM] Auto-recall hook not initialized");
    return;
  }

  if (!config.autoRecall) {
    return;
  }

  // Ensure bootstrapFiles array exists
  if (!event.context) {
    return;
  }
  if (!event.context.bootstrapFiles) {
    event.context.bootstrapFiles = [];
  }

  // Extract prompt from messages
  const prompt = extractPrompt(event);
  if (!prompt || prompt.trim().length === 0) {
    return;
  }

  try {
    // Extract key terms and build search query
    const keyTerms = extractKeyTerms(prompt);
    const searchQuery = keyTerms.length > 0 ? keyTerms.join(" OR ") : prompt.trim();

    // Generate embedding for search
    const queryEmbedding = await embeddingProvider.embed(searchQuery);

    // Perform hybrid search
    const candidateLimit = Math.max(config.injection.maxItems * 3, 30);
    const hybridResults = vectorHelper.hybridSearch(searchQuery, queryEmbedding, { limit: candidateLimit });

    // Get current context
    const currentContext = contextTool.getContext();
    const contextText = currentContext?.text ?? null;

    // If no results, still include current context if present
    if (hybridResults.length === 0) {
      if (contextText) {
        const formatted = formatMemoriesAsXml([], contextText);
        event.context.bootstrapFiles.push({
          path: "MEMORIES.md",
          content: formatted,
        });
      }
      return;
    }

    // Fetch full memory records
    const candidateIds = hybridResults.map((r) => r.id);
    const memories = fetchMemories(candidateIds);

    // Create similarity map
    const similarityMap = new Map<string, number>();
    for (const result of hybridResults) {
      similarityMap.set(result.id, result.vectorScore);
    }

    // Apply tier budget allocation
    const allocation = allocator.allocate(memories, similarityMap);

    // Update access stats
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    for (const { memory } of allocation.selected) {
      updateAccessStats(memory.id, now.toISOString(), today);
    }

    // Format and inject memories
    const selectedMemories = allocation.selected.map((sm) => sm.memory);
    const formattedXml = formatMemoriesAsXml(selectedMemories, contextText);

    event.context.bootstrapFiles.push({
      path: "MEMORIES.md",
      content: formattedXml,
    });

    console.log(`[TRAM] Injected ${selectedMemories.length} memories into context`);
  } catch (error) {
    console.error("[TRAM] Auto-recall error:", error);
  }
};

export default handler;
