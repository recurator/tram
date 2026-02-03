/**
 * memory_store tool - Store new memories in the tiered memory system.
 * Handles duplicate detection, embedding generation, and vector storage.
 */

import { randomUUID } from "node:crypto";
import type { Database as SqliteDb } from "better-sqlite3";
import { Tier, MemoryType, type Memory } from "../core/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { VectorHelper } from "../db/vectors.js";

/**
 * Input parameters for the memory_store tool
 */
export interface MemoryStoreInput {
  /** The memory content text (required) */
  text: string;
  /** Initial tier placement (default: session's defaultTier or HOT) */
  tier?: "HOT" | "WARM";
  /** Type of memory affecting decay rate */
  memory_type?: "procedural" | "factual" | "project" | "episodic";
  /** Importance score (0.0 to 1.0, default: 0.5) */
  importance?: number;
  /** Whether to pin this memory (default: false) */
  pinned?: boolean;
  /** Category for grouping memories */
  category?: string;
  /** Origin of the memory */
  source?: string;
  /** Internal: session's default tier (used when tier is not specified) */
  _sessionDefaultTier?: "HOT" | "WARM" | "COLD" | "ARCHIVE";
}

/**
 * Result from the memory_store tool
 */
export interface MemoryStoreResult {
  /** Response content for the agent */
  content: Array<{ type: "text"; text: string }>;
  /** Details about the created or existing memory */
  details: {
    /** The memory ID */
    id: string;
    /** The memory text */
    text: string;
    /** The memory tier */
    tier: Tier;
    /** The memory type */
    memory_type: MemoryType;
    /** Whether this is a duplicate */
    isDuplicate: boolean;
    /** Similarity score if duplicate */
    similarity?: number;
  };
}

/**
 * Similarity threshold for duplicate detection
 */
const DUPLICATE_THRESHOLD = 0.95;

/**
 * MemoryStoreTool provides the memory_store tool implementation.
 * Stores new memories with duplicate detection and embedding generation.
 */
export class MemoryStoreTool {
  private db: SqliteDb;
  private embeddingProvider: EmbeddingProvider;
  private vectorHelper: VectorHelper;

  /**
   * Create a new MemoryStoreTool instance.
   * @param db - The better-sqlite3 database instance
   * @param embeddingProvider - Provider for generating embeddings
   * @param vectorHelper - Helper for vector storage and search
   */
  constructor(
    db: SqliteDb,
    embeddingProvider: EmbeddingProvider,
    vectorHelper: VectorHelper
  ) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    this.vectorHelper = vectorHelper;
  }

  /**
   * Store a new memory in the tiered memory system.
   * @param input - The memory store parameters
   * @returns The result containing created memory details or duplicate warning
   */
  async execute(input: MemoryStoreInput): Promise<MemoryStoreResult> {
    // Validate required input
    if (!input.text || typeof input.text !== "string") {
      throw new Error("Missing required parameter: text");
    }

    const text = input.text.trim();
    if (text.length === 0) {
      throw new Error("Memory text cannot be empty");
    }

    // Generate embedding for the new memory
    const embedding = await this.embeddingProvider.embed(text);

    // Check for duplicates using vector similarity
    const duplicateResult = await this.findDuplicate(embedding);
    if (duplicateResult) {
      return {
        content: [
          {
            type: "text",
            text: `Similar memory already exists (similarity: ${(duplicateResult.similarity * 100).toFixed(1)}%). Returning existing memory.`,
          },
        ],
        details: {
          id: duplicateResult.id,
          text: duplicateResult.text,
          tier: duplicateResult.tier,
          memory_type: duplicateResult.memory_type,
          isDuplicate: true,
          similarity: duplicateResult.similarity,
        },
      };
    }

    // Create new memory
    const memory = await this.createMemory(input, embedding);

    return {
      content: [
        {
          type: "text",
          text: `Memory stored successfully in ${memory.tier} tier.`,
        },
      ],
      details: {
        id: memory.id,
        text: memory.text,
        tier: memory.tier,
        memory_type: memory.memory_type,
        isDuplicate: false,
      },
    };
  }

  /**
   * Find a duplicate memory based on embedding similarity.
   * @param embedding - The embedding to check against
   * @returns The duplicate memory with similarity score, or null if none found
   */
  private async findDuplicate(
    embedding: number[]
  ): Promise<{
    id: string;
    text: string;
    tier: Tier;
    memory_type: MemoryType;
    similarity: number;
  } | null> {
    // Search for similar vectors
    const results = this.vectorHelper.vectorSearch(embedding, 1);

    if (results.length === 0) {
      return null;
    }

    const topResult = results[0];

    // Check if similarity exceeds threshold
    if (topResult.similarity >= DUPLICATE_THRESHOLD) {
      // Fetch full memory details
      const stmt = this.db.prepare(`
        SELECT id, text, tier, memory_type
        FROM memories
        WHERE id = ?
      `);
      const row = stmt.get(topResult.id) as {
        id: string;
        text: string;
        tier: string;
        memory_type: string;
      } | undefined;

      if (row) {
        return {
          id: row.id,
          text: row.text,
          tier: row.tier as Tier,
          memory_type: row.memory_type as MemoryType,
          similarity: topResult.similarity,
        };
      }
    }

    return null;
  }

  /**
   * Create a new memory record and store its embedding.
   * @param input - The memory store input
   * @param embedding - The pre-computed embedding
   * @returns The created memory
   */
  private async createMemory(
    input: MemoryStoreInput,
    embedding: number[]
  ): Promise<Memory> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const today = now.split("T")[0]; // YYYY-MM-DD

    // Use explicit tier if provided, otherwise use session default, otherwise HOT
    const tier = this.resolveTier(input.tier, input._sessionDefaultTier);
    const memoryType = this.parseMemoryType(input.memory_type);
    const importance = this.clampImportance(input.importance ?? 0.5);
    const pinned = input.pinned ?? false;

    // Insert into memories table
    const insertStmt = this.db.prepare(`
      INSERT INTO memories (
        id, text, importance, category, created_at, tier, memory_type,
        do_not_inject, pinned, use_count, last_accessed_at, use_days, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      id,
      input.text.trim(),
      importance,
      input.category ?? null,
      now,
      tier,
      memoryType,
      0, // do_not_inject
      pinned ? 1 : 0,
      0, // use_count
      now, // last_accessed_at
      JSON.stringify([today]), // use_days
      input.source ?? null
    );

    // Store the embedding
    this.vectorHelper.storeEmbedding(id, embedding);

    return {
      id,
      text: input.text.trim(),
      importance,
      category: input.category ?? null,
      created_at: now,
      tier,
      memory_type: memoryType,
      do_not_inject: false,
      pinned,
      use_count: 0,
      last_accessed_at: now,
      use_days: [today],
      source: input.source ?? null,
      parent_id: null,
    };
  }

  /**
   * Parse and validate memory type input.
   */
  private parseMemoryType(type?: string): MemoryType {
    switch (type) {
      case "procedural":
        return MemoryType.procedural;
      case "factual":
        return MemoryType.factual;
      case "project":
        return MemoryType.project;
      case "episodic":
        return MemoryType.episodic;
      default:
        return MemoryType.factual;
    }
  }

  /**
   * Clamp importance value to valid range [0.0, 1.0].
   */
  private clampImportance(value: number): number {
    return Math.max(0, Math.min(1, value));
  }

  /**
   * Resolve the tier to use for a new memory.
   * Priority: explicit tier > session default > HOT
   * @param explicitTier - Tier explicitly provided by the user
   * @param sessionDefaultTier - Session's default tier from config
   * @returns The resolved Tier enum value
   */
  private resolveTier(
    explicitTier?: "HOT" | "WARM",
    sessionDefaultTier?: "HOT" | "WARM" | "COLD" | "ARCHIVE"
  ): Tier {
    // If explicit tier provided, use it (this overrides session default)
    if (explicitTier !== undefined) {
      return explicitTier === "WARM" ? Tier.WARM : Tier.HOT;
    }

    // If session default is set, use it
    if (sessionDefaultTier !== undefined) {
      switch (sessionDefaultTier) {
        case "HOT":
          return Tier.HOT;
        case "WARM":
          return Tier.WARM;
        case "COLD":
          return Tier.COLD;
        case "ARCHIVE":
          return Tier.ARCHIVE;
        default:
          return Tier.HOT;
      }
    }

    // Default to HOT
    return Tier.HOT;
  }
}

export default MemoryStoreTool;
