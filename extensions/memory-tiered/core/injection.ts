/**
 * TierBudgetAllocator - Allocates memory injection slots by tier
 *
 * Budget allocation for context injection:
 *   - Pinned: 25% (highest priority, bypass decay)
 *   - HOT: 45% (actively used memories)
 *   - WARM: 25% (recently used memories)
 *   - COLD: 5% (infrequently used memories)
 *   - ARCHIVE: 0% (never auto-injected)
 *
 * Filtering:
 *   - Excludes memories with do_not_inject = true
 *   - Fills each bucket by score (highest first)
 */

import { Memory, Tier } from "./types.js";
import { MemoryScorer } from "./scorer.js";

/**
 * Budget configuration for tier-based allocation
 */
export interface BudgetConfig {
  /** Percentage of slots for pinned memories (default: 0.25) */
  pinned: number;
  /** Percentage of slots for HOT tier (default: 0.45) */
  hot: number;
  /** Percentage of slots for WARM tier (default: 0.25) */
  warm: number;
  /** Percentage of slots for COLD tier (default: 0.05) */
  cold: number;
}

export const DEFAULT_BUDGETS: BudgetConfig = {
  pinned: 0.25,
  hot: 0.45,
  warm: 0.25,
  cold: 0.05,
};

/**
 * Allocator configuration
 */
export interface AllocatorConfig {
  /** Maximum number of items to inject (default: 20) */
  maxItems: number;
  /** Budget percentages by tier */
  budgets: BudgetConfig;
}

export const DEFAULT_ALLOCATOR_CONFIG: AllocatorConfig = {
  maxItems: 20,
  budgets: DEFAULT_BUDGETS,
};

/**
 * Memory with its computed score for allocation
 */
export interface ScoredMemory {
  memory: Memory;
  score: number;
}

/**
 * Result of budget allocation showing which memories were selected
 */
export interface AllocationResult {
  /** Selected memories in priority order */
  selected: ScoredMemory[];
  /** Breakdown of counts by bucket */
  breakdown: {
    pinned: number;
    hot: number;
    warm: number;
    cold: number;
  };
  /** Number of memories excluded due to do_not_inject */
  excludedCount: number;
  /** Total memories considered */
  totalConsidered: number;
}

/**
 * Tier-based budget allocator for memory injection
 */
export class TierBudgetAllocator {
  private config: AllocatorConfig;
  private scorer: MemoryScorer;

  constructor(
    config: Partial<AllocatorConfig> = {},
    scorer?: MemoryScorer
  ) {
    this.config = {
      maxItems: config.maxItems ?? DEFAULT_ALLOCATOR_CONFIG.maxItems,
      budgets: {
        ...DEFAULT_BUDGETS,
        ...config.budgets,
      },
    };
    this.scorer = scorer ?? new MemoryScorer();
  }

  /**
   * Allocate injection slots based on tier budgets
   * @param memories All candidate memories
   * @param similarity Optional similarity scores by memory ID (for search-based allocation)
   * @param now Reference time for scoring (default: current time)
   * @returns Allocation result with selected memories
   */
  allocate(
    memories: Memory[],
    similarity: Map<string, number> = new Map(),
    now: Date = new Date()
  ): AllocationResult {
    const totalConsidered = memories.length;

    // Filter out memories that should not be injected
    // Excludes: do_not_inject = true, ARCHIVE tier
    const eligibleMemories = memories.filter(
      (m) => !m.do_not_inject && m.tier !== Tier.ARCHIVE
    );
    const excludedCount = totalConsidered - eligibleMemories.length;

    // Score all eligible memories
    const scoredMemories: ScoredMemory[] = eligibleMemories.map((memory) => ({
      memory,
      score: this.scorer.score(memory, similarity.get(memory.id) ?? 1, now),
    }));

    // Separate pinned memories from tier-based memories
    const pinnedMemories = scoredMemories.filter((sm) => sm.memory.pinned);
    const unpinnedMemories = scoredMemories.filter((sm) => !sm.memory.pinned);

    // Group unpinned memories by tier
    const byTier = {
      [Tier.HOT]: unpinnedMemories.filter((sm) => sm.memory.tier === Tier.HOT),
      [Tier.WARM]: unpinnedMemories.filter((sm) => sm.memory.tier === Tier.WARM),
      [Tier.COLD]: unpinnedMemories.filter((sm) => sm.memory.tier === Tier.COLD),
    };

    // Sort each group by score (highest first)
    pinnedMemories.sort((a, b) => b.score - a.score);
    byTier[Tier.HOT].sort((a, b) => b.score - a.score);
    byTier[Tier.WARM].sort((a, b) => b.score - a.score);
    byTier[Tier.COLD].sort((a, b) => b.score - a.score);

    // Calculate slot counts based on budgets
    const maxItems = this.config.maxItems;
    const budgets = this.config.budgets;

    const pinnedSlots = Math.floor(maxItems * budgets.pinned);
    const hotSlots = Math.floor(maxItems * budgets.hot);
    const warmSlots = Math.floor(maxItems * budgets.warm);
    const coldSlots = Math.floor(maxItems * budgets.cold);

    // Fill buckets up to their slot limits
    const selectedPinned = pinnedMemories.slice(0, pinnedSlots);
    const selectedHot = byTier[Tier.HOT].slice(0, hotSlots);
    const selectedWarm = byTier[Tier.WARM].slice(0, warmSlots);
    const selectedCold = byTier[Tier.COLD].slice(0, coldSlots);

    // Combine all selected memories and sort by score for final ordering
    const allSelected = [
      ...selectedPinned,
      ...selectedHot,
      ...selectedWarm,
      ...selectedCold,
    ];

    // Sort combined result by score (highest first)
    allSelected.sort((a, b) => b.score - a.score);

    // Ensure we don't exceed maxItems (may happen due to rounding)
    const finalSelected = allSelected.slice(0, maxItems);

    // Recount after potential truncation
    const breakdown = {
      pinned: finalSelected.filter((sm) => sm.memory.pinned).length,
      hot: finalSelected.filter(
        (sm) => !sm.memory.pinned && sm.memory.tier === Tier.HOT
      ).length,
      warm: finalSelected.filter(
        (sm) => !sm.memory.pinned && sm.memory.tier === Tier.WARM
      ).length,
      cold: finalSelected.filter(
        (sm) => !sm.memory.pinned && sm.memory.tier === Tier.COLD
      ).length,
    };

    return {
      selected: finalSelected,
      breakdown,
      excludedCount,
      totalConsidered,
    };
  }

  /**
   * Get the current allocator configuration
   */
  getConfig(): AllocatorConfig {
    return {
      maxItems: this.config.maxItems,
      budgets: { ...this.config.budgets },
    };
  }

  /**
   * Update allocator configuration
   */
  setConfig(config: Partial<AllocatorConfig>): void {
    if (config.maxItems !== undefined) {
      this.config.maxItems = config.maxItems;
    }
    if (config.budgets) {
      this.config.budgets = { ...this.config.budgets, ...config.budgets };
    }
  }

  /**
   * Get the associated scorer
   */
  getScorer(): MemoryScorer {
    return this.scorer;
  }
}
