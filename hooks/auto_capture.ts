/**
 * Auto-capture hook for agent_end event.
 * Automatically captures important information from conversations.
 */

import { randomUUID } from "node:crypto";
import type { Database as SqliteDb } from "better-sqlite3";
import { Tier, MemoryType } from "../core/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { VectorHelper } from "../db/vectors.js";
import type { ResolvedConfig } from "../config.js";

/**
 * Result from the auto-capture hook
 */
export interface AutoCaptureResult {
  /** Number of memories captured */
  memoriesCaptured: number;
  /** Details about captured memories */
  captured: Array<{
    id: string;
    text: string;
    memory_type: MemoryType;
  }>;
  /** Number of candidates that were skipped as duplicates */
  duplicatesSkipped: number;
}

/**
 * Configuration for the auto-capture hook
 */
export interface AutoCaptureConfig {
  /** Whether auto-capture is enabled (default: true) */
  enabled: boolean;
  /** Maximum captures per conversation (default: 3) */
  maxCapturesPerConversation: number;
  /** Minimum text length for capturable content (default: 10) */
  minLength: number;
  /** Maximum text length for capturable content (default: 500) */
  maxLength: number;
  /** Similarity threshold for duplicate detection (default: 0.95) */
  duplicateThreshold: number;
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
  // factual is the default, so patterns are for detection confidence
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
 * These patterns detect content that should NOT be captured as memories.
 */
const NOISE_FILTERS: RegExp[] = [
  // Raw channel message metadata (Telegram, Discord, etc.)
  /^\[(?:Telegram|Discord|Signal|WhatsApp|Slack)\s+\w+\s+id:/i,
  // Message ID suffixes
  /\[message_id:\s*\d+\]/,
  // System timestamps at start
  /^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/,
  // Tool call outputs
  /toolCallId|function_results|<function_calls>|<\/antml:function_calls>/,
  // XML-like system tags
  /^<[a-z-]+>[\s\S]*<\/[a-z-]+>$/i,
];

/**
 * Check if text matches any noise filter pattern.
 * @param text - Text to check
 * @returns True if text is noise and should be skipped
 */
function isNoise(text: string): boolean {
  return NOISE_FILTERS.some((pattern) => pattern.test(text));
}

/**
 * AutoCaptureHook provides automatic memory capture from conversations.
 * Registered as an agent_end hook to capture important information.
 */
export class AutoCaptureHook {
  private db: SqliteDb;
  private embeddingProvider: EmbeddingProvider;
  private vectorHelper: VectorHelper;
  private config: AutoCaptureConfig;

  /**
   * Create a new AutoCaptureHook instance.
   * @param db - The better-sqlite3 database instance
   * @param embeddingProvider - Provider for generating embeddings
   * @param vectorHelper - Helper for vector storage and search
   * @param config - Auto-capture configuration
   */
  constructor(
    db: SqliteDb,
    embeddingProvider: EmbeddingProvider,
    vectorHelper: VectorHelper,
    config: Partial<AutoCaptureConfig> = {}
  ) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    this.vectorHelper = vectorHelper;

    // Merge with defaults
    this.config = {
      enabled: config.enabled ?? true,
      maxCapturesPerConversation: config.maxCapturesPerConversation ?? 3,
      minLength: config.minLength ?? 10,
      maxLength: config.maxLength ?? 500,
      duplicateThreshold: config.duplicateThreshold ?? 0.95,
    };
  }

  /**
   * Execute the auto-capture hook at the end of an agent turn.
   * @param response - The agent's response text
   * @returns Hook result with captured memories
   */
  async execute(response: string): Promise<AutoCaptureResult> {
    // Check if auto-capture is enabled
    if (!this.config.enabled) {
      return {
        memoriesCaptured: 0,
        captured: [],
        duplicatesSkipped: 0,
      };
    }

    // Check for empty response
    if (!response || response.trim().length === 0) {
      return {
        memoriesCaptured: 0,
        captured: [],
        duplicatesSkipped: 0,
      };
    }

    // Check if entire response is noise (channel metadata, tool output, etc.)
    if (isNoise(response)) {
      return {
        memoriesCaptured: 0,
        captured: [],
        duplicatesSkipped: 0,
      };
    }

    // Extract capturable text segments
    const candidates = this.extractCapturableCandidates(response);

    if (candidates.length === 0) {
      return {
        memoriesCaptured: 0,
        captured: [],
        duplicatesSkipped: 0,
      };
    }

    const captured: AutoCaptureResult["captured"] = [];
    let duplicatesSkipped = 0;

    // Process candidates up to the limit
    for (const candidate of candidates) {
      // Stop if we've reached the capture limit
      if (captured.length >= this.config.maxCapturesPerConversation) {
        break;
      }

      // Generate embedding for the candidate
      const embedding = await this.embeddingProvider.embed(candidate.text);

      // Check for duplicates
      const isDuplicate = await this.isDuplicate(embedding);
      if (isDuplicate) {
        duplicatesSkipped++;
        continue;
      }

      // Store the memory
      const id = await this.storeMemory(candidate.text, candidate.type, embedding);
      captured.push({
        id,
        text: candidate.text,
        memory_type: candidate.type,
      });
    }

    return {
      memoriesCaptured: captured.length,
      captured,
      duplicatesSkipped,
    };
  }

  /**
   * Extract capturable text candidates from a response.
   * Looks for segments between minLength and maxLength characters.
   * @param response - The full response text
   * @returns Array of capturable candidates with detected memory type
   */
  private extractCapturableCandidates(
    response: string
  ): Array<{ text: string; type: MemoryType }> {
    const candidates: Array<{ text: string; type: MemoryType; score: number }> = [];

    // Split into paragraphs/segments (double newline or significant breaks)
    const segments = response
      .split(/\n\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const segment of segments) {
      // Skip noise segments (channel metadata, tool output, etc.)
      if (isNoise(segment)) {
        continue;
      }

      // Skip segments outside length bounds
      if (segment.length < this.config.minLength || segment.length > this.config.maxLength) {
        // Try to extract sentences if segment is too long
        if (segment.length > this.config.maxLength) {
          const sentences = this.extractSentences(segment);
          for (const sentence of sentences) {
            if (sentence.length >= this.config.minLength && sentence.length <= this.config.maxLength && !isNoise(sentence)) {
              const { type, score } = this.detectMemoryType(sentence);
              candidates.push({ text: sentence, type, score });
            }
          }
        }
        continue;
      }

      // Detect memory type and calculate importance score
      const { type, score } = this.detectMemoryType(segment);
      candidates.push({ text: segment, type, score });
    }

    // Sort by score (higher = more likely to be important)
    candidates.sort((a, b) => b.score - a.score);

    // Return top candidates without the score
    return candidates.slice(0, this.config.maxCapturesPerConversation * 2).map(({ text, type }) => ({
      text,
      type,
    }));
  }

  /**
   * Extract individual sentences from a text segment.
   * @param text - Text to split into sentences
   * @returns Array of sentences
   */
  private extractSentences(text: string): string[] {
    // Simple sentence splitting on common terminators
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    return sentences;
  }

  /**
   * Detect the memory type based on content patterns.
   * @param text - Text to analyze
   * @returns Detected memory type and confidence score
   */
  private detectMemoryType(text: string): { type: MemoryType; score: number } {
    let bestType = MemoryType.factual;
    let bestScore = 0;

    for (const { type, patterns } of MEMORY_TYPE_PATTERNS) {
      let matchCount = 0;
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          matchCount++;
        }
      }

      // Calculate score based on match percentage
      const score = matchCount / patterns.length;
      if (score > bestScore) {
        bestScore = score;
        bestType = type;
      }
    }

    // Base score is low if no patterns matched
    const baseScore = bestScore > 0 ? bestScore : 0.1;

    // Boost score based on text characteristics indicating importance
    let importanceBoost = 0;

    // Longer texts (within bounds) tend to be more informative
    const lengthRatio = text.length / this.config.maxLength;
    importanceBoost += lengthRatio * 0.2;

    // Text with code-like patterns is often technical/important
    if (/`[^`]+`/.test(text)) {
      importanceBoost += 0.3;
    }

    // Text with specific mentions/references
    if (/\b(note|important|remember|key|critical|essential)\b/i.test(text)) {
      importanceBoost += 0.2;
    }

    // Lists often contain structured information
    if (/^[-*•]\s/m.test(text) || /^\d+\.\s/m.test(text)) {
      importanceBoost += 0.15;
    }

    return {
      type: bestType,
      score: Math.min(baseScore + importanceBoost, 1.0),
    };
  }

  /**
   * Check if a memory with similar embedding already exists.
   * @param embedding - The embedding to check
   * @returns True if a duplicate exists (similarity >= threshold)
   */
  private async isDuplicate(embedding: number[]): Promise<boolean> {
    // Search for similar vectors
    const results = this.vectorHelper.vectorSearch(embedding, 1);

    if (results.length === 0) {
      return false;
    }

    return results[0].similarity >= this.config.duplicateThreshold;
  }

  /**
   * Store a new memory in the database.
   * @param text - Memory content text
   * @param memoryType - Detected memory type
   * @param embedding - Pre-computed embedding
   * @returns The created memory ID
   */
  private async storeMemory(
    text: string,
    memoryType: MemoryType,
    embedding: number[]
  ): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const today = now.split("T")[0]; // YYYY-MM-DD

    // Insert into memories table
    const insertStmt = this.db.prepare(`
      INSERT INTO memories (
        id, text, importance, category, created_at, tier, memory_type,
        do_not_inject, pinned, use_count, last_accessed_at, use_days, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      id,
      text,
      0.5, // default importance
      null, // no category for auto-captured
      now,
      Tier.HOT, // always store as HOT tier
      memoryType,
      0, // do_not_inject = false
      0, // pinned = false
      0, // use_count
      now, // last_accessed_at
      JSON.stringify([today]), // use_days
      "auto-capture" // source
    );

    // Store the embedding
    this.vectorHelper.storeEmbedding(id, embedding);

    return id;
  }

  /**
   * Check if auto-capture is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Enable or disable auto-capture.
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): AutoCaptureConfig {
    return { ...this.config };
  }
}

/**
 * Create an AutoCaptureHook from resolved plugin config.
 * @param db - Database instance
 * @param embeddingProvider - Embedding provider
 * @param vectorHelper - Vector helper
 * @param config - Resolved plugin configuration
 * @returns Configured AutoCaptureHook instance
 */
export function createAutoCaptureHook(
  db: SqliteDb,
  embeddingProvider: EmbeddingProvider,
  vectorHelper: VectorHelper,
  config: ResolvedConfig
): AutoCaptureHook {
  return new AutoCaptureHook(db, embeddingProvider, vectorHelper, {
    enabled: config.autoCapture,
  });
}

export default AutoCaptureHook;
