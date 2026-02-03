/**
 * Core type definitions for the tiered memory system
 */

/**
 * Memory tiers from most active to least active.
 * - HOT: Actively used, high priority for injection
 * - WARM: Recently used, moderate priority
 * - COLD: Infrequently used, low priority
 * - ARCHIVE: Historical, never auto-injected
 */
export enum Tier {
  HOT = "HOT",
  WARM = "WARM",
  COLD = "COLD",
  ARCHIVE = "ARCHIVE",
}

/**
 * Types of memories based on their content and purpose.
 * Each type has different decay half-lives.
 */
export enum MemoryType {
  /** How-to knowledge, long-lasting (180 day half-life) */
  procedural = "procedural",
  /** Facts and data (90 day half-life) */
  factual = "factual",
  /** Project-specific context (45 day half-life) */
  project = "project",
  /** Conversation/event memories (10 day half-life) */
  episodic = "episodic",
}

/**
 * A memory entry in the tiered memory system
 */
export interface Memory {
  /** Unique identifier (UUID) */
  id: string;
  /** The memory content text */
  text: string;
  /** Importance score (0.0 to 1.0) */
  importance: number;
  /** Category for grouping memories */
  category: string | null;
  /** When the memory was created (ISO 8601) */
  created_at: string;
  /** Current tier placement */
  tier: Tier;
  /** Type of memory affecting decay rate */
  memory_type: MemoryType;
  /** If true, excluded from auto-injection (soft-deleted) */
  do_not_inject: boolean;
  /** If true, never decays and gets priority injection */
  pinned: boolean;
  /** Number of times this memory has been accessed */
  use_count: number;
  /** When the memory was last accessed (ISO 8601) */
  last_accessed_at: string;
  /** JSON array of distinct days (YYYY-MM-DD) when accessed */
  use_days: string[];
  /** Origin of the memory (e.g., 'user', 'auto-capture', 'file:path') */
  source: string | null;
  /** ID of parent memory for hierarchical relationships */
  parent_id: string | null;
}

/**
 * Active task context with time-to-live
 */
export interface CurrentContext {
  /** Context identifier (typically 'active') */
  id: string;
  /** The context text */
  text: string;
  /** When the context was created (ISO 8601) */
  created_at: string;
  /** Time-to-live in seconds */
  ttl_seconds: number;
}

/**
 * Audit log entry for tracking memory state changes
 */
export interface MemoryAudit {
  /** Unique audit entry identifier */
  id: string;
  /** ID of the affected memory */
  memory_id: string;
  /** Action performed (e.g., 'forget', 'restore', 'pin', 'unpin', 'demote', 'promote') */
  action: string;
  /** Previous value (action-specific, JSON string or null) */
  old_value: string | null;
  /** New value (action-specific, JSON string or null) */
  new_value: string | null;
  /** When the action occurred (ISO 8601) */
  created_at: string;
}

/**
 * Injection feedback entry for tracking injection outcomes and usefulness metrics
 */
export interface InjectionFeedback {
  /** Unique feedback entry identifier */
  id: string;
  /** ID of the injected memory */
  memory_id: string;
  /** Session key identifying the session where injection occurred */
  session_key: string;
  /** When the memory was injected (ISO 8601) */
  injected_at: string;
  /** Number of times this memory was accessed after injection */
  access_frequency: number;
  /** Outcome of the session (e.g., 'success', 'failure', 'partial') */
  session_outcome: string | null;
  /** Ratio of injected memories to total candidates */
  injection_density: number;
  /** Resistance to decay based on usage patterns */
  decay_resistance: number | null;
  /** Computed proxy score for usefulness (0.0 to 1.0) */
  proxy_score: number | null;
  /** Agent-provided score for usefulness (0.0 to 1.0) */
  agent_score: number | null;
  /** Agent-provided notes about usefulness */
  agent_notes: string | null;
  /** When the feedback entry was created (ISO 8601) */
  created_at: string;
}
