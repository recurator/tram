/**
 * Prototype: before_tool_call hook handler for tool-specific memory injection.
 *
 * STATUS: PROTOTYPE - NOT PRODUCTION READY
 * This file demonstrates how TRAM could integrate with OpenClaw's before_tool_call
 * hook (introduced in v2026.2.1 via PRs #6570 and #6660).
 *
 * @see https://github.com/openclaw/openclaw/pull/6570
 * @see https://github.com/openclaw/openclaw/pull/6660
 */

import type { Database as SqliteDb } from "better-sqlite3";
import type { EmbeddingProvider } from "../../embeddings/provider.js";
import { VectorHelper } from "../../db/vectors.js";
import type { ResolvedConfig, SessionTypeValue } from "../../config.js";

// ============================================================================
// API DOCUMENTATION: before_tool_call Hook (OpenClaw 2026.2.1)
// ============================================================================

/**
 * BeforeToolCallEvent - Event payload received when before_tool_call fires.
 *
 * Hook signature from PRs #6570/#6660:
 * - toolName: string - Name of the tool being invoked (e.g., "web_search", "bash", "memory_recall")
 * - toolCallId: string - Unique identifier for this specific tool invocation
 * - params: Record<string, unknown> - Parameters being passed to the tool
 *
 * When it fires:
 * - AFTER agent decides to use a tool
 * - AFTER parameter validation passes
 * - BEFORE the tool's execute() method is called
 *
 * This timing allows plugins to:
 * 1. Inject additional context before tool execution
 * 2. Modify tool parameters (with care)
 * 3. Log/audit tool usage
 * 4. Block suspicious tool calls (via throwing)
 */
export interface BeforeToolCallEvent {
  /** Name of the tool being called */
  toolName: string;
  /** Unique identifier for this tool call */
  toolCallId: string;
  /** Parameters passed to the tool */
  params: Record<string, unknown>;
}

/**
 * BeforeToolCallResult - Optional result to modify tool execution.
 *
 * - prependContext: string | undefined - Text to inject into agent context
 *   before the tool result. This allows the agent to see additional information
 *   that might help interpret tool output.
 *
 * - modifyParams: Record<string, unknown> | undefined - Modified parameters
 *   to use instead of original params. Use with extreme care - changing params
 *   can break tool contracts and cause unexpected behavior.
 */
export interface BeforeToolCallResult {
  /** Content to add before tool execution (injected into agent context) */
  prependContext?: string;
  /** Modified parameters (use with caution) */
  modifyParams?: Record<string, unknown>;
}

/**
 * BeforeToolCallContext - Session context available during hook execution.
 *
 * Available context (same as other OpenClaw hooks):
 * - session.type: "main" | "cron" | "spawned"
 * - sessionKey: Unique session identifier
 * - workspaceDir: Current workspace directory
 * - agentId: Current agent identifier
 */
export interface BeforeToolCallContext {
  session?: {
    type?: string;
  };
  sessionKey?: string;
  workspaceDir?: string;
  agentId?: string;
}

/**
 * Hook handler type for before_tool_call
 */
export type BeforeToolCallHandler = (
  event: BeforeToolCallEvent,
  ctx: BeforeToolCallContext
) => Promise<BeforeToolCallResult | void> | BeforeToolCallResult | void;

// ============================================================================
// TOOL CATEGORY MAPPINGS
// ============================================================================

/**
 * Map tools to memory-relevant categories for targeted memory injection.
 *
 * Categories enable TRAM to inject memories most relevant to the tool being used.
 * For example, when using bash, inject procedural memories about shell commands.
 */
type ToolCategory = "code" | "search" | "file" | "web" | "memory" | "system" | "unknown";

const TOOL_CATEGORY_MAP: Record<string, ToolCategory> = {
  // Code-related tools - inject procedural memories about coding patterns
  bash: "code",
  execute: "code",
  run_code: "code",
  lint: "code",
  test: "code",

  // Search tools - inject memories about past searches and findings
  web_search: "search",
  search_files: "search",
  ripgrep: "search",
  grep: "search",

  // File tools - inject project-specific memories about file locations
  read_file: "file",
  write_file: "file",
  edit_file: "file",
  list_files: "file",

  // Web tools - inject memories about web interactions
  fetch_url: "web",
  browser: "web",

  // Memory tools - skip injection to avoid recursion
  memory_store: "memory",
  memory_recall: "memory",
  memory_forget: "memory",
  memory_explain: "memory",

  // System tools - inject memories about environment setup
  spawn_agent: "system",
  subprocess: "system",
};

/**
 * Memory type preferences by tool category.
 * Maps categories to the most relevant memory types to inject.
 */
const CATEGORY_MEMORY_TYPE_PREFERENCES: Record<ToolCategory, string[]> = {
  code: ["procedural", "project"],     // How-to and project-specific knowledge
  search: ["factual", "episodic"],      // Facts and past search results
  file: ["project", "procedural"],      // Project structure and conventions
  web: ["factual", "episodic"],         // Known facts and past web interactions
  memory: [],                            // No injection for memory tools
  system: ["procedural", "project"],    // System setup and project config
  unknown: ["factual"],                  // Default to factual memories
};

// ============================================================================
// MODULE STATE
// ============================================================================

let db: SqliteDb | null = null;
let embeddingProvider: EmbeddingProvider | null = null;
let vectorHelper: VectorHelper | null = null;
let config: ResolvedConfig | null = null;

/**
 * Initialize the before_tool_call hook with required dependencies.
 * Called by the plugin during registration.
 */
export function initBeforeToolCallHook(
  database: SqliteDb,
  embedding: EmbeddingProvider,
  vectors: VectorHelper,
  pluginConfig: ResolvedConfig
): void {
  db = database;
  embeddingProvider = embedding;
  vectorHelper = vectors;
  config = pluginConfig;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get the category for a tool.
 */
function getToolCategory(toolName: string): ToolCategory {
  return TOOL_CATEGORY_MAP[toolName] ?? "unknown";
}

/**
 * Build a search query based on tool and parameters.
 * Extracts meaningful keywords from tool parameters.
 */
function buildSearchQuery(toolName: string, params: Record<string, unknown>): string {
  const parts: string[] = [];

  // Add tool name for context
  parts.push(toolName);

  // Extract searchable content from common parameter patterns
  const stringParams = ["query", "command", "code", "path", "file", "url", "text"];
  for (const key of stringParams) {
    if (typeof params[key] === "string") {
      const value = params[key] as string;
      // Take first 100 chars to avoid overly long queries
      parts.push(value.slice(0, 100));
    }
  }

  return parts.join(" ");
}

/**
 * Format injected memories as concise context.
 * Different from auto-recall XML format - this is inline text.
 */
function formatAsInlineContext(
  memories: Array<{ id: string; text: string; memory_type: string }>,
  toolName: string
): string {
  if (memories.length === 0) {
    return "";
  }

  const lines: string[] = [];
  lines.push(`[TRAM context for ${toolName}:]`);

  for (const memory of memories) {
    // Truncate long memories for inline context
    const truncated = memory.text.length > 150
      ? memory.text.slice(0, 150) + "..."
      : memory.text;
    lines.push(`- ${truncated}`);
  }

  return lines.join("\n");
}

// ============================================================================
// PROTOTYPE HOOK HANDLER
// ============================================================================

/**
 * Prototype handler for before_tool_call event.
 *
 * DESIGN DECISIONS:
 *
 * 1. Skip memory tools to avoid injection recursion
 *    When agent calls memory_recall, we don't inject more memories.
 *
 * 2. Category-based memory type filtering
 *    Different tools benefit from different memory types:
 *    - bash/code tools → procedural memories (how to do things)
 *    - search tools → factual/episodic (what we know, past searches)
 *    - file tools → project memories (codebase conventions)
 *
 * 3. Limited injection (max 3 memories)
 *    Tool calls are frequent - we inject minimally to avoid context bloat.
 *
 * 4. Parameter-aware search
 *    Use tool parameters (query, command, path) to find relevant memories.
 *
 * PERFORMANCE CONSIDERATIONS:
 * - Embedding generation: ~50-200ms per query (local) or ~100-500ms (API)
 * - Vector search: ~5-20ms
 * - Total overhead per tool call: 50-500ms
 *
 * This overhead is significant for fast tools (bash), acceptable for slow tools (web_search).
 */
export const handler: BeforeToolCallHandler = async (
  event: BeforeToolCallEvent,
  ctx: BeforeToolCallContext
): Promise<BeforeToolCallResult | void> => {
  // Check if initialized
  if (!db || !embeddingProvider || !vectorHelper || !config) {
    return; // Not initialized, skip silently
  }

  // Get tool category
  const category = getToolCategory(event.toolName);

  // Skip memory tools to avoid recursion
  if (category === "memory") {
    return;
  }

  // Get preferred memory types for this tool category
  const preferredTypes = CATEGORY_MEMORY_TYPE_PREFERENCES[category];
  if (preferredTypes.length === 0) {
    return; // No injection for this category
  }

  try {
    // Build search query from tool params
    const searchQuery = buildSearchQuery(event.toolName, event.params);
    if (!searchQuery || searchQuery.length < 3) {
      return;
    }

    // Generate embedding for search
    const queryEmbedding = await embeddingProvider.embed(searchQuery);

    // Search for relevant memories (limited to 10 candidates)
    const results = vectorHelper.hybridSearch(searchQuery, queryEmbedding, { limit: 10 });

    if (results.length === 0) {
      return;
    }

    // Fetch full memory records with type filtering
    const placeholders = results.map(() => "?").join(", ");
    const typeFilter = preferredTypes.map(() => "?").join(", ");

    const stmt = db.prepare(`
      SELECT id, text, memory_type
      FROM memories
      WHERE id IN (${placeholders})
        AND memory_type IN (${typeFilter})
        AND forgotten = 0
        AND do_not_inject = 0
      ORDER BY importance DESC
      LIMIT 3
    `);

    const memories = stmt.all(
      ...results.map((r) => r.id),
      ...preferredTypes
    ) as Array<{ id: string; text: string; memory_type: string }>;

    if (memories.length === 0) {
      return;
    }

    // Format memories as inline context
    const context = formatAsInlineContext(memories, event.toolName);

    console.log(`[TRAM] Injected ${memories.length} memories before ${event.toolName}`);

    return {
      prependContext: context,
    };
  } catch (error) {
    // Log but don't throw - don't break tool execution
    console.error("[TRAM] before_tool_call error:", error);
    return;
  }
};

export default handler;
