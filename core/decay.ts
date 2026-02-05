/**
 * DecayEngine - Background decay service for automatic tier demotion.
 *
 * Linear decay flow: HOT → WARM → COLD → ARCHIVE
 *
 * Rules:
 *   - HOT memories past hotTTL (measured by last_accessed_at) → WARM
 *   - WARM memories unused > warmTTL days → COLD
 *   - COLD memories unused > coldTTL days → ARCHIVE
 *   - Pinned memories never decay
 *   - null TTL means memory never demotes from that tier
 *   - Creates audit log entries for all demotions (includes memory_type)
 *   - Stores last_decay_run timestamp in DB meta table
 *
 * TTL values support both duration strings ("1h", "7d") and numeric values
 * for backwards compatibility (hours for hot, days for warm/cold).
 */

import { randomUUID } from "node:crypto";
import type { Database as SqliteDb } from "better-sqlite3";
import { Tier, type Memory, MemoryType } from "./types.js";
import type { ResolvedConfig, MemoryTypeValue } from "../config.js";
import { parseDuration } from "../utils/duration.js";
import { getActiveDecayTTLs, resolveActiveDecayProfile } from "./active-profile.js";

/**
 * Result from running the decay engine
 */
export interface DecayResult {
  /** Number of HOT memories demoted to WARM */
  hotDemoted: number;
  /** Number of WARM memories demoted to COLD */
  warmDemoted: number;
  /** Number of COLD memories demoted to ARCHIVE */
  coldDemoted: number;
  /** Total memories processed (checked for decay) */
  totalProcessed: number;
  /** Timestamp when decay was run */
  runAt: string;
  /** Active decay profile used for this run */
  activeProfile?: {
    name: string;
    source: string;
    hotTtl: string | number;
    warmTtl: string | number;
    coldTtl: string | number;
  };
}

/**
 * Memory row from database for decay checks
 */
interface MemoryRow {
  id: string;
  tier: string;
  pinned: number;
  created_at: string;
  last_accessed_at: string;
  memory_type: MemoryTypeValue;
}

/**
 * DecayEngine handles automatic tier demotion based on time and usage.
 * Supports category-aware decay with per-memory-type TTL overrides.
 * Implements linear decay: HOT → WARM → COLD → ARCHIVE
 *
 * TTL Resolution Order (for each tier):
 * 1. Per-memory-type override from config (config.decay.overrides[type])
 * 2. Active decay profile (from memory_tune or persisted in meta table)
 * 3. Config default (config.decay.default)
 * 4. Hardcoded fallback
 */
export class DecayEngine {
  private db: SqliteDb;
  private decayConfig: ResolvedConfig["decay"];
  private fullConfig: ResolvedConfig;

  /**
   * Create a new DecayEngine instance.
   * @param db - The better-sqlite3 database instance
   * @param config - Resolved plugin configuration (optional, uses defaults)
   */
  constructor(db: SqliteDb, config?: Partial<ResolvedConfig>) {
    this.db = db;
    // Store the full decay config for category-aware TTL lookups
    this.decayConfig = {
      intervalHours: config?.decay?.intervalHours ?? 6,
      default: {
        hotTTL: config?.decay?.default?.hotTTL ?? 72,
        warmTTL: config?.decay?.default?.warmTTL ?? 60,
        coldTTL: config?.decay?.default?.coldTTL ?? 180,
      },
      overrides: config?.decay?.overrides ?? ({} as Record<MemoryTypeValue, { hotTTL: number | null; warmTTL: number | null; coldTTL?: number | null }>),
    };
    // Store full config for active profile resolution
    this.fullConfig = config as ResolvedConfig;

    // Ensure meta table exists for storing last_decay_run
    this.ensureMetaTable();
  }

  /**
   * Get the HOT TTL for a memory type.
   *
   * Resolution order:
   * 1. Per-memory-type override (config.decay.overrides[type].hotTTL)
   * 2. Explicit active decay profile (session, agent, global, or config - NOT builtin)
   * 3. Config default (config.decay.default.hotTTL)
   *
   * @param memoryType - The memory type to look up
   * @returns TTL value (string or number), or null if should never demote
   */
  private getHotTTL(memoryType: MemoryTypeValue): string | number | null {
    // 1. Per-memory-type override has highest priority
    const override = this.decayConfig.overrides[memoryType];
    if (override !== undefined && override.hotTTL !== undefined) {
      return override.hotTTL;
    }

    // 2. Active decay profile (only if explicitly set, not builtin default)
    if (this.fullConfig) {
      try {
        const resolved = resolveActiveDecayProfile(this.db, this.fullConfig);
        // Only use profile if explicitly configured (not builtin fallback)
        if (resolved.source !== "builtin") {
          return resolved.values.hotTtl;
        }
      } catch {
        // Fall through to config default
      }
    }

    // 3. Config default
    return this.decayConfig.default.hotTTL;
  }

  /**
   * Get the WARM TTL for a memory type.
   *
   * Resolution order:
   * 1. Per-memory-type override (config.decay.overrides[type].warmTTL)
   * 2. Explicit active decay profile (session, agent, global, or config - NOT builtin)
   * 3. Config default (config.decay.default.warmTTL)
   *
   * @param memoryType - The memory type to look up
   * @returns TTL value (string or number), or null if should never demote
   */
  private getWarmTTL(memoryType: MemoryTypeValue): string | number | null {
    // 1. Per-memory-type override has highest priority
    const override = this.decayConfig.overrides[memoryType];
    if (override !== undefined && override.warmTTL !== undefined) {
      return override.warmTTL;
    }

    // 2. Active decay profile (only if explicitly set, not builtin default)
    if (this.fullConfig) {
      try {
        const resolved = resolveActiveDecayProfile(this.db, this.fullConfig);
        // Only use profile if explicitly configured (not builtin fallback)
        if (resolved.source !== "builtin") {
          return resolved.values.warmTtl;
        }
      } catch {
        // Fall through to config default
      }
    }

    // 3. Config default
    return this.decayConfig.default.warmTTL;
  }

  /**
   * Get the COLD TTL for a memory type.
   *
   * Resolution order:
   * 1. Per-memory-type override (config.decay.overrides[type].coldTTL)
   * 2. Explicit active decay profile (session, agent, global, or config - NOT builtin)
   * 3. Config default (config.decay.default.coldTTL)
   *
   * @param memoryType - The memory type to look up
   * @returns TTL value (string or number), or null if should never demote
   */
  private getColdTTL(memoryType: MemoryTypeValue): string | number | null {
    // 1. Per-memory-type override has highest priority
    const override = this.decayConfig.overrides[memoryType];
    if (override !== undefined && override.coldTTL !== undefined) {
      return override.coldTTL;
    }

    // 2. Active decay profile (only if explicitly set, not builtin default)
    if (this.fullConfig) {
      try {
        const resolved = resolveActiveDecayProfile(this.db, this.fullConfig);
        // Only use profile if explicitly configured (not builtin fallback)
        if (resolved.source !== "builtin") {
          return resolved.values.coldTtl;
        }
      } catch {
        // Fall through to config default
      }
    }

    // 3. Config default
    return (this.decayConfig.default as { hotTTL: number; warmTTL: number; coldTTL?: number }).coldTTL ?? 180;
  }

  /**
   * Run the decay engine to demote stale memories.
   * Linear flow: HOT → WARM → COLD → ARCHIVE
   * @returns Result containing counts of demoted memories
   */
  run(): DecayResult {
    const now = new Date();
    const nowIso = now.toISOString();

    let hotDemoted = 0;
    let warmDemoted = 0;
    let coldDemoted = 0;
    let totalProcessed = 0;

    // Process HOT tier demotions (HOT → WARM)
    const hotMemories = this.fetchMemoriesByTier(Tier.HOT);
    for (const memory of hotMemories) {
      totalProcessed++;
      if (this.shouldDemoteHot(memory, now)) {
        this.demoteMemory(memory.id, Tier.HOT, Tier.WARM, memory.memory_type, nowIso);
        hotDemoted++;
      }
    }

    // Process WARM tier demotions (WARM → COLD)
    const warmMemories = this.fetchMemoriesByTier(Tier.WARM);
    for (const memory of warmMemories) {
      totalProcessed++;
      if (this.shouldDemoteWarm(memory, now)) {
        this.demoteMemory(memory.id, Tier.WARM, Tier.COLD, memory.memory_type, nowIso);
        warmDemoted++;
      }
    }

    // Process COLD tier demotions (COLD → ARCHIVE)
    const coldMemories = this.fetchMemoriesByTier(Tier.COLD);
    for (const memory of coldMemories) {
      totalProcessed++;
      if (this.shouldDemoteCold(memory, now)) {
        this.demoteMemory(memory.id, Tier.COLD, Tier.ARCHIVE, memory.memory_type, nowIso);
        coldDemoted++;
      }
    }

    // Store last decay run timestamp
    this.setLastDecayRun(nowIso);

    // Get active profile info for the result
    let activeProfile: DecayResult["activeProfile"];
    if (this.fullConfig) {
      try {
        const resolved = resolveActiveDecayProfile(this.db, this.fullConfig);
        activeProfile = {
          name: resolved.profile,
          source: resolved.source,
          hotTtl: resolved.values.hotTtl,
          warmTtl: resolved.values.warmTtl,
          coldTtl: resolved.values.coldTtl,
        };
      } catch {
        // Leave undefined if resolution fails
      }
    }

    return {
      hotDemoted,
      warmDemoted,
      coldDemoted,
      totalProcessed,
      runAt: nowIso,
      activeProfile,
    };
  }

  /**
   * Get the timestamp of the last decay run.
   * @returns ISO 8601 timestamp or null if never run
   */
  getLastDecayRun(): string | null {
    try {
      const stmt = this.db.prepare(`
        SELECT value FROM meta WHERE key = ?
      `);
      const row = stmt.get("last_decay_run") as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      // Meta table might not exist in legacy databases
      return null;
    }
  }

  /**
   * Check if enough time has passed since last decay run.
   * @param intervalHours - Minimum hours between runs
   * @returns True if decay should run, false otherwise
   */
  shouldRun(intervalHours: number): boolean {
    const lastRun = this.getLastDecayRun();
    if (!lastRun) {
      return true;
    }

    const lastRunTime = new Date(lastRun).getTime();
    const now = Date.now();
    const intervalMs = intervalHours * 60 * 60 * 1000;

    return now - lastRunTime >= intervalMs;
  }

  /**
   * Ensure the meta table exists for storing decay run timestamps.
   */
  private ensureMetaTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  /**
   * Fetch all memories in a specific tier that are not pinned.
   * @param tier - The tier to fetch
   * @returns Array of memory rows
   */
  private fetchMemoriesByTier(tier: Tier): MemoryRow[] {
    const stmt = this.db.prepare(`
      SELECT id, tier, pinned, created_at, last_accessed_at, memory_type
      FROM memories
      WHERE tier = ? AND pinned = 0
    `);
    return stmt.all(tier) as MemoryRow[];
  }

  /**
   * Check if a HOT memory should be demoted to WARM.
   * Rule: HOT memories inactive past hotTTL → WARM
   * Uses last_accessed_at for consistency with other tiers.
   * TTL is looked up per memory type; null TTL means never demote.
   * @param memory - The memory row
   * @param now - Current time
   * @returns True if should demote
   */
  private shouldDemoteHot(memory: MemoryRow, now: Date): boolean {
    const hotTTL = this.getHotTTL(memory.memory_type);
    // null TTL means never demote from this tier
    if (hotTTL === null) {
      return false;
    }
    // Use last_accessed_at for consistency across all tiers
    const lastAccessedAt = new Date(memory.last_accessed_at);
    const inactiveMs = now.getTime() - lastAccessedAt.getTime();
    // Parse TTL with default unit of hours (backwards compatible)
    const ttlMs = parseDuration(hotTTL, "h");
    return inactiveMs > ttlMs;
  }

  /**
   * Check if a WARM memory should be demoted to COLD.
   * Rule: WARM memories unused > warmTTL → COLD
   * TTL is looked up per memory type; null TTL means never demote.
   * @param memory - The memory row
   * @param now - Current time
   * @returns True if should demote
   */
  private shouldDemoteWarm(memory: MemoryRow, now: Date): boolean {
    const warmTTL = this.getWarmTTL(memory.memory_type);
    // null TTL means never demote from this tier
    if (warmTTL === null) {
      return false;
    }
    const lastAccessedAt = new Date(memory.last_accessed_at);
    const inactiveMs = now.getTime() - lastAccessedAt.getTime();
    // Parse TTL with default unit of days (backwards compatible)
    const ttlMs = parseDuration(warmTTL, "d");
    return inactiveMs > ttlMs;
  }

  /**
   * Check if a COLD memory should be demoted to ARCHIVE.
   * Rule: COLD memories unused > coldTTL → ARCHIVE
   * TTL is looked up per memory type; null TTL means never demote.
   * @param memory - The memory row
   * @param now - Current time
   * @returns True if should demote
   */
  private shouldDemoteCold(memory: MemoryRow, now: Date): boolean {
    const coldTTL = this.getColdTTL(memory.memory_type);
    // null TTL means never demote from this tier
    if (coldTTL === null) {
      return false;
    }
    const lastAccessedAt = new Date(memory.last_accessed_at);
    const inactiveMs = now.getTime() - lastAccessedAt.getTime();
    // Parse TTL with default unit of days (backwards compatible)
    const ttlMs = parseDuration(coldTTL, "d");
    return inactiveMs > ttlMs;
  }

  /**
   * Demote a memory to a lower tier and create audit entry.
   * @param memoryId - The memory ID
   * @param fromTier - Original tier
   * @param toTier - Target tier
   * @param memoryType - The memory's type (for audit context)
   * @param timestamp - ISO timestamp for the demotion
   */
  private demoteMemory(
    memoryId: string,
    fromTier: Tier,
    toTier: Tier,
    memoryType: MemoryTypeValue,
    timestamp: string
  ): void {
    // Update the tier
    const updateStmt = this.db.prepare(`
      UPDATE memories
      SET tier = ?
      WHERE id = ?
    `);
    updateStmt.run(toTier, memoryId);

    // Create audit entry with memory_type in context
    this.createAuditEntry(
      memoryId,
      "demote",
      JSON.stringify({ tier: fromTier, memory_type: memoryType }),
      JSON.stringify({ tier: toTier, memory_type: memoryType }),
      timestamp
    );
  }

  /**
   * Store the last decay run timestamp in the meta table.
   * @param timestamp - ISO 8601 timestamp
   */
  private setLastDecayRun(timestamp: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO meta (key, value, updated_at)
      VALUES (?, ?, ?)
    `);
    stmt.run("last_decay_run", timestamp, timestamp);
  }

  /**
   * Create an audit log entry for a demotion action.
   * @param memoryId - The memory ID
   * @param action - The action type
   * @param oldValue - Previous value (JSON string)
   * @param newValue - New value (JSON string)
   * @param createdAt - Timestamp of the action
   */
  private createAuditEntry(
    memoryId: string,
    action: string,
    oldValue: string | null,
    newValue: string | null,
    createdAt: string
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO memory_audit (id, memory_id, action, old_value, new_value, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(randomUUID(), memoryId, action, oldValue, newValue, createdAt);
  }
}

export default DecayEngine;
