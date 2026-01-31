/**
 * Phase 2 Extension Point Interfaces
 *
 * These interfaces define extension points for enhanced memory management capabilities
 * planned for Phase 2 of the tiered memory system. The database schema already includes
 * the nullable columns (entity_refs, meta_type) needed to support these features.
 *
 * Phase 2 will focus on:
 * - Entity extraction for knowledge graph integration
 * - Memory compaction to consolidate related memories
 * - Semantic deduplication to reduce redundancy
 */

import type { Memory } from "./types.js";

/**
 * Represents an extracted entity from memory text.
 * Entities can be people, organizations, concepts, locations, or other named items.
 */
export interface Entity {
  /** The entity name/text as extracted */
  name: string;
  /** Entity type (e.g., 'person', 'organization', 'concept', 'location', 'technology') */
  type: string;
  /** Character offset where entity starts in source text */
  startOffset: number;
  /** Character offset where entity ends in source text */
  endOffset: number;
  /** Confidence score for this extraction (0.0 to 1.0) */
  confidence: number;
  /** Optional metadata specific to entity type */
  metadata?: Record<string, unknown>;
}

/**
 * Entity Extractor Interface
 *
 * Phase 2 Intent:
 * - Extract named entities (people, orgs, concepts, etc.) from memory text
 * - Populate entity_refs column with JSON array of entity references
 * - Enable knowledge graph construction linking memories via shared entities
 * - Support entity-based search and filtering (e.g., "all memories mentioning X")
 * - Allow for different extraction backends (NLP models, pattern matching, LLM-based)
 *
 * The entity_refs column in the memories table will store:
 * JSON array of { name, type, confidence } objects for quick lookup.
 *
 * Usage scenarios:
 * - Auto-tag memories with relevant entities on storage
 * - Build relationship graphs between memories
 * - Enable "related memories" suggestions based on shared entities
 * - Support faceted search by entity type
 */
export interface EntityExtractor {
  /**
   * Extract entities from the given text.
   *
   * @param text - The memory text to analyze
   * @returns Array of extracted entities with positions and confidence scores
   */
  extract(text: string): Promise<Entity[]>;

  /**
   * Extract entities from multiple texts in batch for efficiency.
   *
   * @param texts - Array of memory texts to analyze
   * @returns Array of entity arrays, one per input text
   */
  extractBatch?(texts: string[]): Promise<Entity[][]>;

  /**
   * Get the name/identifier of this extractor implementation.
   */
  getName(): string;

  /**
   * Get supported entity types this extractor can identify.
   */
  getSupportedTypes(): string[];
}

/**
 * Memory Compactor Interface
 *
 * Phase 2 Intent:
 * - Consolidate multiple related memories into a single comprehensive memory
 * - Reduce memory count while preserving information
 * - Improve recall quality by removing fragmentation
 * - Save storage and embedding computation costs
 *
 * Compaction strategies might include:
 * - Merging memories with overlapping content
 * - Summarizing conversation threads into single memories
 * - Combining incremental updates about the same topic
 * - Rolling up episodic memories into factual summaries
 *
 * The parent_id column can be used to maintain provenance:
 * - Compacted memory references source memories via parent relationships
 * - Original memories can be archived rather than deleted
 * - Allows "uncompact" operation by restoring from archive
 *
 * Usage scenarios:
 * - Periodic maintenance to consolidate fragmented knowledge
 * - Explicit user command to "consolidate memories about X"
 * - Automatic compaction when memory count exceeds threshold
 */
export interface MemoryCompactor {
  /**
   * Compact multiple memories into a single consolidated memory.
   *
   * The returned memory should:
   * - Preserve all important information from sources
   * - Have appropriate tier (typically WARM for compacted)
   * - Reference source memories via parent relationships
   * - Have meta_type set to 'compacted' for identification
   *
   * @param memories - Array of memories to compact (2 or more)
   * @returns A new memory consolidating the input memories
   */
  compact(memories: Memory[]): Promise<Memory>;

  /**
   * Find groups of memories that are candidates for compaction.
   *
   * @param memories - All memories to analyze
   * @param options - Compaction criteria options
   * @returns Array of memory groups, each group is a compaction candidate
   */
  findCompactionCandidates?(
    memories: Memory[],
    options?: {
      /** Minimum similarity threshold to consider memories related */
      similarityThreshold?: number;
      /** Minimum group size to suggest compaction */
      minGroupSize?: number;
      /** Maximum age difference in days for grouping */
      maxAgeDays?: number;
    }
  ): Promise<Memory[][]>;

  /**
   * Get the name/identifier of this compactor implementation.
   */
  getName(): string;
}

/**
 * Semantic Deduplicator Interface
 *
 * Phase 2 Intent:
 * - Identify semantically duplicate or near-duplicate memories
 * - Go beyond the simple 0.95 similarity threshold used currently
 * - Consider memory type, context, and content structure
 * - Suggest merge/delete actions for redundant memories
 *
 * Deduplication strategies:
 * - Vector similarity with context-aware thresholds
 * - Paraphrase detection for different wordings of same info
 * - Subsumption detection (one memory contains another)
 * - Temporal deduplication (same info captured at different times)
 *
 * The meta_type column can mark memories as:
 * - 'duplicate' for identified duplicates
 * - 'canonical' for the kept version
 * - 'subsumed' for memories covered by more comprehensive ones
 *
 * Usage scenarios:
 * - Background job to periodically identify duplicates
 * - Pre-storage check with smarter duplicate detection
 * - User command to "find and clean up duplicates"
 * - Automatic consolidation during tier demotion
 */
export interface SemanticDeduplicator {
  /**
   * Find memories that are duplicates of the given memory.
   *
   * @param memory - The memory to check for duplicates
   * @returns Array of memories that are semantic duplicates
   */
  findDuplicates(memory: Memory): Promise<Memory[]>;

  /**
   * Find all duplicate groups within the given memories.
   *
   * @param memories - All memories to analyze
   * @param options - Deduplication criteria options
   * @returns Array of duplicate groups, first item in each group is the "canonical" version
   */
  findAllDuplicateGroups?(
    memories: Memory[],
    options?: {
      /** Similarity threshold for duplicate detection (default 0.9) */
      threshold?: number;
      /** Consider memory type when grouping (default true) */
      respectMemoryType?: boolean;
      /** Maximum age difference to consider same duplicate (days) */
      maxAgeDays?: number;
    }
  ): Promise<Memory[][]>;

  /**
   * Suggest an action for each duplicate group.
   *
   * @param duplicateGroup - Array of duplicate memories, first is canonical
   * @returns Suggested action for each non-canonical memory
   */
  suggestActions?(
    duplicateGroup: Memory[]
  ): Promise<Array<{
    memory: Memory;
    action: "delete" | "archive" | "merge" | "keep";
    reason: string;
  }>>;

  /**
   * Get the name/identifier of this deduplicator implementation.
   */
  getName(): string;
}

/**
 * Extension registry for managing Phase 2 extensions.
 * This interface will be implemented in Phase 2 to allow dynamic registration.
 */
export interface ExtensionRegistry {
  /**
   * Register an entity extractor implementation.
   */
  registerEntityExtractor(extractor: EntityExtractor): void;

  /**
   * Register a memory compactor implementation.
   */
  registerMemoryCompactor(compactor: MemoryCompactor): void;

  /**
   * Register a semantic deduplicator implementation.
   */
  registerSemanticDeduplicator(deduplicator: SemanticDeduplicator): void;

  /**
   * Get the registered entity extractor.
   */
  getEntityExtractor(): EntityExtractor | null;

  /**
   * Get the registered memory compactor.
   */
  getMemoryCompactor(): MemoryCompactor | null;

  /**
   * Get the registered semantic deduplicator.
   */
  getSemanticDeduplicator(): SemanticDeduplicator | null;
}
