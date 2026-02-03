/**
 * Auto-capture hook handler for command:stop event.
 * Captures important information from conversations.
 */

import { randomUUID } from "node:crypto";
import type { Database as SqliteDb } from "better-sqlite3";
import { Tier, MemoryType } from "../../core/types.js";
import type { EmbeddingProvider } from "../../embeddings/provider.js";
import { VectorHelper } from "../../db/vectors.js";
import type { ResolvedConfig, SessionTypeValue } from "../../config.js";

/**
 * OpenClaw agent_end event interface
 * See: openclaw/src/plugins/types.ts - PluginHookAgentEndEvent
 */
export interface AgentEndEvent {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
}

/**
 * OpenClaw session context interface
 * See: openclaw/src/plugins/types.ts - PluginHookSessionContext
 */
export interface SessionContext {
  type?: string;
}

/**
 * OpenClaw agent context interface
 * See: openclaw/src/plugins/types.ts - PluginHookAgentContext
 */
export interface AgentContext {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  messageProvider?: string;
  session?: SessionContext;
}

/**
 * Hook handler type for agent_end
 */
export type HookHandler = (
  event: AgentEndEvent,
  ctx: AgentContext
) => Promise<void> | void;

// Valid session types (used for validation)
const VALID_SESSION_TYPES: readonly SessionTypeValue[] = ["main", "cron", "spawned"] as const;

/**
 * Get the session type from the agent context.
 * Validates the type against known session types and defaults to "main".
 * @param ctx - The agent context from the hook event
 * @returns The session type: "main", "cron", or "spawned"
 */
export function getSessionType(ctx: AgentContext): SessionTypeValue {
  const sessionType = ctx.session?.type;

  // Unknown/missing type defaults to main
  if (!sessionType) {
    return "main";
  }

  // Validate against known types
  if (VALID_SESSION_TYPES.includes(sessionType as SessionTypeValue)) {
    return sessionType as SessionTypeValue;
  }

  // Unknown type defaults to main
  return "main";
}

// Module-level state (initialized by plugin registration)
let db: SqliteDb | null = null;
let embeddingProvider: EmbeddingProvider | null = null;
let vectorHelper: VectorHelper | null = null;
let config: ResolvedConfig | null = null;
let currentSessionType: SessionTypeValue = "main";

// Configuration defaults
const MAX_CAPTURES_PER_CONVERSATION = 3;
const MIN_LENGTH = 10;
const MAX_LENGTH = 500;
const DUPLICATE_THRESHOLD = 0.95;

/**
 * Initialize the hook with required dependencies.
 * Called by the plugin during registration.
 */
export function initAutoCaptureHook(
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

/**
 * Patterns for detecting memory types from content
 */
const MEMORY_TYPE_PATTERNS: Array<{
  type: MemoryType;
  patterns: RegExp[];
}> = [
  {
    type: MemoryType.procedural,
    patterns: [
      /\bhow\s+to\b/i,
      /\bsteps?\s+to\b/i,
      /\bprocedure\b/i,
      /\bprocess\b/i,
      /\bworkflow\b/i,
      /\brun\s+the\s+command\b/i,
      /\bexecute\b/i,
      /\binstall\b/i,
      /\bconfigure\b/i,
      /\bsetup\b/i,
      /\bto\s+do\s+this\b/i,
      /\bfollow\s+these\b/i,
      /\bfirst,?\s+then\b/i,
      /\bstart\s+by\b/i,
    ],
  },
  {
    type: MemoryType.project,
    patterns: [
      /\bproject\b/i,
      /\brepository\b/i,
      /\bcodebase\b/i,
      /\barchitecture\b/i,
      /\bimplementation\b/i,
      /\bfeature\b/i,
      /\bmodule\b/i,
      /\bcomponent\b/i,
      /\bservice\b/i,
      /\bapi\b/i,
      /\bendpoint\b/i,
      /\bdatabase\b/i,
      /\bschema\b/i,
      /\bmigration\b/i,
    ],
  },
  {
    type: MemoryType.episodic,
    patterns: [
      /\byesterday\b/i,
      /\btoday\b/i,
      /\blast\s+week\b/i,
      /\blast\s+month\b/i,
      /\brecently\b/i,
      /\bjust\s+now\b/i,
      /\bwe\s+discussed\b/i,
      /\bwe\s+agreed\b/i,
      /\byou\s+mentioned\b/i,
      /\bi\s+remember\b/i,
      /\bmeeting\b/i,
      /\bconversation\b/i,
      /\bdiscussion\b/i,
    ],
  },
  {
    type: MemoryType.factual,
    patterns: [
      /\bis\s+defined\s+as\b/i,
      /\bmeans\s+that\b/i,
      /\brefers\s+to\b/i,
      /\bknown\s+as\b/i,
      /\bcalled\b/i,
      /\bversion\b/i,
      /\brequires?\b/i,
      /\bdepends?\s+on\b/i,
      /\bcompat\w+\s+with\b/i,
      /\bsupports?\b/i,
      /\bdefault\b/i,
      /\bformat\b/i,
      /\bsyntax\b/i,
    ],
  },
];

/**
 * Noise filters to skip raw channel metadata and system messages.
 */
const NOISE_FILTERS: RegExp[] = [
  /^\[(?:Telegram|Discord|Signal|WhatsApp|Slack)\s+\w+\s+id:/i,
  /\[message_id:\s*\d+\]/,
  /^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/,
  /toolCallId|function_results|<function_calls>|<\/antml:function_calls>/,
  /^<[a-z-]+>[\s\S]*<\/[a-z-]+>$/i,
];

/**
 * Check if text matches any noise filter pattern.
 */
function isNoise(text: string): boolean {
  return NOISE_FILTERS.some((pattern) => pattern.test(text));
}

/**
 * Message structure from OpenClaw
 */
interface Message {
  role: string;
  content?: string | Array<{ type: string; text?: string }>;
}

/**
 * Extract assistant response text from messages.
 */
function extractAssistantResponse(event: AgentEndEvent): string | null {
  if (!event.messages || event.messages.length === 0) {
    return null;
  }

  // Find the last assistant message
  for (let i = event.messages.length - 1; i >= 0; i--) {
    const msg = event.messages[i] as Message;
    if (msg.role === "assistant") {
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
 * Detect the memory type based on content patterns.
 */
function detectMemoryType(text: string): { type: MemoryType; score: number } {
  let bestType = MemoryType.factual;
  let bestScore = 0;

  for (const { type, patterns } of MEMORY_TYPE_PATTERNS) {
    let matchCount = 0;
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        matchCount++;
      }
    }
    const score = matchCount / patterns.length;
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  const baseScore = bestScore > 0 ? bestScore : 0.1;
  let importanceBoost = 0;

  const lengthRatio = text.length / MAX_LENGTH;
  importanceBoost += lengthRatio * 0.2;

  if (/`[^`]+`/.test(text)) {
    importanceBoost += 0.3;
  }
  if (/\b(note|important|remember|key|critical|essential)\b/i.test(text)) {
    importanceBoost += 0.2;
  }
  if (/^[-*\u2022]\s/m.test(text) || /^\d+\.\s/m.test(text)) {
    importanceBoost += 0.15;
  }

  return {
    type: bestType,
    score: Math.min(baseScore + importanceBoost, 1.0),
  };
}

/**
 * Extract capturable text candidates from a response.
 */
function extractCapturableCandidates(
  response: string
): Array<{ text: string; type: MemoryType; score: number }> {
  const candidates: Array<{ text: string; type: MemoryType; score: number }> = [];

  const segments = response
    .split(/\n\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const segment of segments) {
    if (isNoise(segment)) {
      continue;
    }

    if (segment.length < MIN_LENGTH || segment.length > MAX_LENGTH) {
      if (segment.length > MAX_LENGTH) {
        const sentences = segment
          .split(/(?<=[.!?])\s+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        for (const sentence of sentences) {
          if (sentence.length >= MIN_LENGTH && sentence.length <= MAX_LENGTH && !isNoise(sentence)) {
            const { type, score } = detectMemoryType(sentence);
            candidates.push({ text: sentence, type, score });
          }
        }
      }
      continue;
    }

    const { type, score } = detectMemoryType(segment);
    candidates.push({ text: segment, type, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, MAX_CAPTURES_PER_CONVERSATION * 2);
}

/**
 * Check if a memory with similar embedding already exists.
 */
async function isDuplicate(embedding: number[]): Promise<boolean> {
  if (!vectorHelper) return false;

  const results = vectorHelper.vectorSearch(embedding, 1);
  if (results.length === 0) {
    return false;
  }

  return results[0].similarity >= DUPLICATE_THRESHOLD;
}

/**
 * Store a new memory in the database.
 */
async function storeMemory(
  text: string,
  memoryType: MemoryType,
  embedding: number[]
): Promise<string> {
  if (!db || !vectorHelper) {
    throw new Error("Database not initialized");
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const today = now.split("T")[0];

  const insertStmt = db.prepare(`
    INSERT INTO memories (
      id, text, importance, category, created_at, tier, memory_type,
      do_not_inject, pinned, use_count, last_accessed_at, use_days, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertStmt.run(
    id,
    text,
    0.5,
    null,
    now,
    Tier.HOT,
    memoryType,
    0,
    0,
    0,
    now,
    JSON.stringify([today]),
    "auto-capture"
  );

  vectorHelper.storeEmbedding(id, embedding);

  return id;
}

/**
 * Hook handler for agent_end event.
 * Captures important information from the conversation.
 */
export const handler: HookHandler = async (
  event: AgentEndEvent,
  ctx: AgentContext
): Promise<void> => {
  // Check if initialized and enabled
  if (!db || !embeddingProvider || !vectorHelper || !config) {
    console.error("[TRAM] Auto-capture hook not initialized");
    return;
  }

  // Detect session type from context
  currentSessionType = getSessionType(ctx);

  // Check if auto-capture is enabled for this session type
  const sessionConfig = config.sessions[currentSessionType];
  if (!sessionConfig.autoCapture) {
    return;
  }

  // Also check global autoCapture setting
  if (!config.autoCapture) {
    return;
  }

  // Only capture from successful conversations
  if (!event.success) {
    return;
  }

  // Extract assistant response
  const response = extractAssistantResponse(event);
  if (!response || response.trim().length === 0) {
    return;
  }

  // Check if entire response is noise
  if (isNoise(response)) {
    return;
  }

  try {
    // Extract capturable candidates
    const candidates = extractCapturableCandidates(response);
    if (candidates.length === 0) {
      return;
    }

    let captured = 0;
    let duplicatesSkipped = 0;

    for (const candidate of candidates) {
      if (captured >= MAX_CAPTURES_PER_CONVERSATION) {
        break;
      }

      // Generate embedding
      const embedding = await embeddingProvider.embed(candidate.text);

      // Check for duplicates
      if (await isDuplicate(embedding)) {
        duplicatesSkipped++;
        continue;
      }

      // Store the memory
      await storeMemory(candidate.text, candidate.type, embedding);
      captured++;
    }

    if (captured > 0) {
      console.log(`[TRAM] Auto-captured ${captured} memories (${duplicatesSkipped} duplicates skipped)`);
    }
  } catch (error) {
    console.error("[TRAM] Auto-capture error:", error);
  }
};

/**
 * Get the current session type detected from the last hook invocation.
 * This provides hooks access to the session type via getCurrentSessionType().
 * @returns The current session type: "main", "cron", or "spawned"
 */
export function getCurrentSessionType(): SessionTypeValue {
  return currentSessionType;
}

export default handler;
