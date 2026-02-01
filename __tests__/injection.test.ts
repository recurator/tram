/**
 * Unit tests for TierBudgetAllocator
 *
 * Tests tier-based budget allocation for memory injection:
 *   - Default budgets (25% pinned, 45% HOT, 25% WARM, 5% COLD)
 *   - ARCHIVE exclusion
 *   - do_not_inject exclusion
 *   - Bucket filling by score within tier
 *   - maxItems limit
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  TierBudgetAllocator,
  DEFAULT_BUDGETS,
  DEFAULT_ALLOCATOR_CONFIG,
  type BudgetConfig,
  type AllocatorConfig,
} from "../core/injection.js";
import { MemoryScorer } from "../core/scorer.js";
import { Memory, MemoryType, Tier } from "../core/types.js";

/**
 * Create a test memory with sensible defaults
 */
function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date().toISOString();
  return {
    id: `test-memory-${Math.random().toString(36).substring(2, 9)}`,
    text: "Test memory content",
    importance: 0.5,
    category: null,
    created_at: now,
    tier: Tier.HOT,
    memory_type: MemoryType.factual,
    do_not_inject: false,
    pinned: false,
    use_count: 0,
    last_accessed_at: now,
    use_days: [],
    source: null,
    parent_id: null,
    ...overrides,
  };
}

/**
 * Create multiple test memories with different IDs
 */
function createTestMemories(
  count: number,
  overrides: Partial<Memory> = {}
): Memory[] {
  return Array.from({ length: count }, (_, i) =>
    createTestMemory({
      id: `memory-${i}`,
      text: `Memory content ${i}`,
      ...overrides,
    })
  );
}

describe("TierBudgetAllocator", () => {
  let allocator: TierBudgetAllocator;

  beforeEach(() => {
    allocator = new TierBudgetAllocator();
  });

  describe("constructor and configuration", () => {
    it("should use default config when none provided", () => {
      const config = allocator.getConfig();
      expect(config.maxItems).toBe(DEFAULT_ALLOCATOR_CONFIG.maxItems);
      expect(config.budgets).toEqual(DEFAULT_BUDGETS);
    });

    it("should allow custom maxItems", () => {
      const customAllocator = new TierBudgetAllocator({ maxItems: 10 });
      expect(customAllocator.getConfig().maxItems).toBe(10);
    });

    it("should allow custom budgets", () => {
      const customBudgets: BudgetConfig = {
        pinned: 0.3,
        hot: 0.4,
        warm: 0.2,
        cold: 0.1,
      };
      const customAllocator = new TierBudgetAllocator({
        budgets: customBudgets,
      });
      expect(customAllocator.getConfig().budgets).toEqual(customBudgets);
    });

    it("should allow partial budget overrides", () => {
      const customAllocator = new TierBudgetAllocator({
        budgets: { pinned: 0.5 } as BudgetConfig,
      });
      const budgets = customAllocator.getConfig().budgets;
      expect(budgets.pinned).toBe(0.5);
      expect(budgets.hot).toBe(DEFAULT_BUDGETS.hot);
      expect(budgets.warm).toBe(DEFAULT_BUDGETS.warm);
      expect(budgets.cold).toBe(DEFAULT_BUDGETS.cold);
    });

    it("should accept custom scorer", () => {
      const customScorer = new MemoryScorer({ similarity: 0.8 });
      const customAllocator = new TierBudgetAllocator({}, customScorer);
      expect(customAllocator.getScorer()).toBe(customScorer);
    });

    it("should allow updating config via setConfig", () => {
      allocator.setConfig({ maxItems: 15 });
      expect(allocator.getConfig().maxItems).toBe(15);

      allocator.setConfig({ budgets: { pinned: 0.4 } as BudgetConfig });
      expect(allocator.getConfig().budgets.pinned).toBe(0.4);
    });
  });

  describe("default budgets (25% pinned, 45% HOT, 25% WARM, 5% COLD)", () => {
    it("should have correct default budget percentages", () => {
      expect(DEFAULT_BUDGETS.pinned).toBe(0.25);
      expect(DEFAULT_BUDGETS.hot).toBe(0.45);
      expect(DEFAULT_BUDGETS.warm).toBe(0.25);
      expect(DEFAULT_BUDGETS.cold).toBe(0.05);
    });

    it("should have budgets summing to 1.0", () => {
      const sum =
        DEFAULT_BUDGETS.pinned +
        DEFAULT_BUDGETS.hot +
        DEFAULT_BUDGETS.warm +
        DEFAULT_BUDGETS.cold;
      expect(sum).toBeCloseTo(1.0, 10);
    });

    it("should allocate correct slots with maxItems=20", () => {
      // With maxItems=20, we expect:
      // - pinned: 20 * 0.25 = 5
      // - hot: 20 * 0.45 = 9
      // - warm: 20 * 0.25 = 5
      // - cold: 20 * 0.05 = 1

      // Create enough memories for each tier
      const now = new Date();
      const pinnedMemories = createTestMemories(10, {
        pinned: true,
        tier: Tier.WARM,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });
      const hotMemories = createTestMemories(15, {
        tier: Tier.HOT,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });
      const warmMemories = createTestMemories(10, {
        tier: Tier.WARM,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });
      const coldMemories = createTestMemories(5, {
        tier: Tier.COLD,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const allMemories = [
        ...pinnedMemories,
        ...hotMemories,
        ...warmMemories,
        ...coldMemories,
      ];

      const result = allocator.allocate(allMemories, new Map(), now);

      expect(result.breakdown.pinned).toBe(5);
      expect(result.breakdown.hot).toBe(9);
      expect(result.breakdown.warm).toBe(5);
      expect(result.breakdown.cold).toBe(1);
      expect(result.selected.length).toBe(20);
    });

    it("should use fewer slots when tier has insufficient memories", () => {
      const now = new Date();

      // Only 2 HOT memories, but budget allows 9
      const memories = [
        ...createTestMemories(5, { pinned: true, tier: Tier.WARM }),
        ...createTestMemories(2, { tier: Tier.HOT }), // Less than budget
        ...createTestMemories(10, { tier: Tier.WARM }),
        ...createTestMemories(5, { tier: Tier.COLD }),
      ];

      const result = allocator.allocate(memories, new Map(), now);

      expect(result.breakdown.hot).toBe(2); // Only 2 available
      expect(result.breakdown.pinned).toBe(5);
      expect(result.breakdown.warm).toBe(5);
      expect(result.breakdown.cold).toBe(1);
      // Total: 2 + 5 + 5 + 1 = 13 (less than maxItems due to insufficient HOT)
      expect(result.selected.length).toBe(13);
    });
  });

  describe("ARCHIVE tier exclusion", () => {
    it("should exclude ARCHIVE tier memories from allocation", () => {
      const now = new Date();
      const archiveMemories = createTestMemories(10, {
        tier: Tier.ARCHIVE,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const result = allocator.allocate(archiveMemories, new Map(), now);

      expect(result.selected.length).toBe(0);
      expect(result.excludedCount).toBe(10);
      expect(result.totalConsidered).toBe(10);
    });

    it("should exclude ARCHIVE even if pinned", () => {
      const now = new Date();
      const memories = [
        createTestMemory({
          id: "archive-pinned",
          tier: Tier.ARCHIVE,
          pinned: true, // Pinned but still ARCHIVE
        }),
        createTestMemory({
          id: "warm-pinned",
          tier: Tier.WARM,
          pinned: true, // This one should be included
        }),
      ];

      const result = allocator.allocate(memories, new Map(), now);

      expect(result.selected.length).toBe(1);
      expect(result.selected[0].memory.id).toBe("warm-pinned");
      expect(result.excludedCount).toBe(1);
    });

    it("should allocate to other tiers when ARCHIVE is mixed in", () => {
      const now = new Date();
      const memories = [
        ...createTestMemories(5, { tier: Tier.ARCHIVE }),
        ...createTestMemories(10, { tier: Tier.HOT }),
        ...createTestMemories(5, { tier: Tier.WARM }),
      ];

      const result = allocator.allocate(memories, new Map(), now);

      // ARCHIVE should be excluded
      expect(result.excludedCount).toBe(5);
      // Should only allocate from HOT and WARM
      const hasArchive = result.selected.some(
        (sm) => sm.memory.tier === Tier.ARCHIVE
      );
      expect(hasArchive).toBe(false);
    });
  });

  describe("do_not_inject exclusion", () => {
    it("should exclude memories with do_not_inject=true", () => {
      const now = new Date();
      const memories = createTestMemories(10, {
        tier: Tier.HOT,
        do_not_inject: true,
      });

      const result = allocator.allocate(memories, new Map(), now);

      expect(result.selected.length).toBe(0);
      expect(result.excludedCount).toBe(10);
    });

    it("should include memories with do_not_inject=false", () => {
      const now = new Date();
      const memories = createTestMemories(5, {
        tier: Tier.HOT,
        do_not_inject: false,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const result = allocator.allocate(memories, new Map(), now);

      expect(result.selected.length).toBe(5);
      expect(result.excludedCount).toBe(0);
    });

    it("should filter out do_not_inject from mixed set", () => {
      const now = new Date();
      const memories = [
        createTestMemory({
          id: "injectable-1",
          tier: Tier.HOT,
          do_not_inject: false,
        }),
        createTestMemory({
          id: "not-injectable",
          tier: Tier.HOT,
          do_not_inject: true,
        }),
        createTestMemory({
          id: "injectable-2",
          tier: Tier.HOT,
          do_not_inject: false,
        }),
      ];

      const result = allocator.allocate(memories, new Map(), now);

      expect(result.selected.length).toBe(2);
      expect(result.excludedCount).toBe(1);
      const selectedIds = result.selected.map((sm) => sm.memory.id);
      expect(selectedIds).toContain("injectable-1");
      expect(selectedIds).toContain("injectable-2");
      expect(selectedIds).not.toContain("not-injectable");
    });

    it("should exclude do_not_inject even if pinned", () => {
      const now = new Date();
      const memory = createTestMemory({
        tier: Tier.WARM,
        pinned: true,
        do_not_inject: true, // Should still be excluded
      });

      const result = allocator.allocate([memory], new Map(), now);

      expect(result.selected.length).toBe(0);
      expect(result.excludedCount).toBe(1);
    });
  });

  describe("bucket filling by score within tier", () => {
    it("should select highest scoring memories within each tier", () => {
      const now = new Date();

      // Create HOT memories with different use_counts (affects score)
      const lowScoreHot = createTestMemory({
        id: "hot-low",
        tier: Tier.HOT,
        use_count: 0,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });
      const midScoreHot = createTestMemory({
        id: "hot-mid",
        tier: Tier.HOT,
        use_count: 25,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });
      const highScoreHot = createTestMemory({
        id: "hot-high",
        tier: Tier.HOT,
        use_count: 100,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      // Allocate with maxItems=2, HOT gets 45% = 0.9 (floor=0), so use custom config
      const smallAllocator = new TierBudgetAllocator({
        maxItems: 5,
        budgets: { pinned: 0, hot: 1.0, warm: 0, cold: 0 },
      });

      const result = smallAllocator.allocate(
        [lowScoreHot, midScoreHot, highScoreHot],
        new Map(),
        now
      );

      // Should select all 3 since we have room
      expect(result.selected.length).toBe(3);

      // First selected should be highest score
      expect(result.selected[0].memory.id).toBe("hot-high");
      expect(result.selected[1].memory.id).toBe("hot-mid");
      expect(result.selected[2].memory.id).toBe("hot-low");
    });

    it("should use similarity scores when provided", () => {
      const now = new Date();

      const memory1 = createTestMemory({
        id: "mem-1",
        tier: Tier.HOT,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });
      const memory2 = createTestMemory({
        id: "mem-2",
        tier: Tier.HOT,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      // mem-1 has lower similarity but same other properties
      const similarities = new Map<string, number>([
        ["mem-1", 0.3],
        ["mem-2", 0.9],
      ]);

      const smallAllocator = new TierBudgetAllocator({
        maxItems: 2,
        budgets: { pinned: 0, hot: 1.0, warm: 0, cold: 0 },
      });

      const result = smallAllocator.allocate(
        [memory1, memory2],
        similarities,
        now
      );

      // mem-2 should be first due to higher similarity
      expect(result.selected[0].memory.id).toBe("mem-2");
      expect(result.selected[1].memory.id).toBe("mem-1");
    });

    it("should sort pinned memories by score independently", () => {
      const now = new Date();

      const pinnedLow = createTestMemory({
        id: "pinned-low",
        tier: Tier.WARM,
        pinned: true,
        use_count: 0,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });
      const pinnedHigh = createTestMemory({
        id: "pinned-high",
        tier: Tier.WARM,
        pinned: true,
        use_count: 100,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const result = allocator.allocate([pinnedLow, pinnedHigh], new Map(), now);

      // Both should be selected (only 2 memories)
      expect(result.selected.length).toBe(2);
      // High score should come first
      expect(result.selected[0].memory.id).toBe("pinned-high");
      expect(result.selected[1].memory.id).toBe("pinned-low");
    });

    it("should sort final result by overall score", () => {
      const now = new Date();

      // High-scoring COLD memory
      const coldHigh = createTestMemory({
        id: "cold-high",
        tier: Tier.COLD,
        use_count: 100,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      // Low-scoring HOT memory
      const hotLow = createTestMemory({
        id: "hot-low",
        tier: Tier.HOT,
        use_count: 0,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const result = allocator.allocate([coldHigh, hotLow], new Map(), now);

      // Both should be selected
      expect(result.selected.length).toBe(2);
      // Final ordering should be by score (cold has higher score due to use_count)
      // But COLD tier has 0.5x recency penalty, so let's verify order
      const scores = result.selected.map((sm) => sm.score);
      expect(scores[0]).toBeGreaterThanOrEqual(scores[1]);
    });
  });

  describe("maxItems limit", () => {
    it("should not exceed maxItems even with many memories", () => {
      const now = new Date();
      // Create many more memories than maxItems
      const memories = [
        ...createTestMemories(20, {
          pinned: true,
          tier: Tier.WARM,
          created_at: now.toISOString(),
          last_accessed_at: now.toISOString(),
        }),
        ...createTestMemories(50, {
          tier: Tier.HOT,
          created_at: now.toISOString(),
          last_accessed_at: now.toISOString(),
        }),
        ...createTestMemories(30, {
          tier: Tier.WARM,
          created_at: now.toISOString(),
          last_accessed_at: now.toISOString(),
        }),
        ...createTestMemories(20, {
          tier: Tier.COLD,
          created_at: now.toISOString(),
          last_accessed_at: now.toISOString(),
        }),
      ];

      const result = allocator.allocate(memories, new Map(), now);

      expect(result.selected.length).toBeLessThanOrEqual(
        DEFAULT_ALLOCATOR_CONFIG.maxItems
      );
    });

    it("should respect custom maxItems setting", () => {
      const customAllocator = new TierBudgetAllocator({ maxItems: 5 });
      const now = new Date();
      const memories = createTestMemories(20, {
        tier: Tier.HOT,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const result = customAllocator.allocate(memories, new Map(), now);

      expect(result.selected.length).toBeLessThanOrEqual(5);
    });

    it("should return fewer items when not enough eligible memories", () => {
      const now = new Date();
      const memories = createTestMemories(3, {
        tier: Tier.HOT,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const result = allocator.allocate(memories, new Map(), now);

      expect(result.selected.length).toBe(3);
      expect(result.totalConsidered).toBe(3);
    });

    it("should handle maxItems=0", () => {
      const zeroAllocator = new TierBudgetAllocator({ maxItems: 0 });
      const now = new Date();
      const memories = createTestMemories(10, { tier: Tier.HOT });

      const result = zeroAllocator.allocate(memories, new Map(), now);

      expect(result.selected.length).toBe(0);
    });

    it("should handle very small maxItems with fractional budgets", () => {
      // With maxItems=4:
      // pinned: 4 * 0.25 = 1
      // hot: 4 * 0.45 = 1 (floor)
      // warm: 4 * 0.25 = 1
      // cold: 4 * 0.05 = 0 (floor)
      const smallAllocator = new TierBudgetAllocator({ maxItems: 4 });
      const now = new Date();

      const memories = [
        ...createTestMemories(5, { pinned: true, tier: Tier.WARM }),
        ...createTestMemories(5, { tier: Tier.HOT }),
        ...createTestMemories(5, { tier: Tier.WARM }),
        ...createTestMemories(5, { tier: Tier.COLD }),
      ];

      const result = smallAllocator.allocate(memories, new Map(), now);

      expect(result.breakdown.pinned).toBe(1);
      expect(result.breakdown.hot).toBe(1);
      expect(result.breakdown.warm).toBe(1);
      expect(result.breakdown.cold).toBe(0);
      expect(result.selected.length).toBe(3);
    });
  });

  describe("AllocationResult metadata", () => {
    it("should include correct totalConsidered count", () => {
      const now = new Date();
      const memories = createTestMemories(15, { tier: Tier.HOT });

      const result = allocator.allocate(memories, new Map(), now);

      expect(result.totalConsidered).toBe(15);
    });

    it("should count excludedCount correctly", () => {
      const now = new Date();
      const memories = [
        ...createTestMemories(3, { tier: Tier.ARCHIVE }),
        ...createTestMemories(2, { do_not_inject: true, tier: Tier.HOT }),
        ...createTestMemories(5, { tier: Tier.HOT }),
      ];

      const result = allocator.allocate(memories, new Map(), now);

      expect(result.excludedCount).toBe(5); // 3 ARCHIVE + 2 do_not_inject
      expect(result.totalConsidered).toBe(10);
    });

    it("should provide accurate breakdown by tier", () => {
      const now = new Date();
      const memories = [
        ...createTestMemories(3, {
          pinned: true,
          tier: Tier.WARM,
          created_at: now.toISOString(),
          last_accessed_at: now.toISOString(),
        }),
        ...createTestMemories(4, {
          tier: Tier.HOT,
          created_at: now.toISOString(),
          last_accessed_at: now.toISOString(),
        }),
        ...createTestMemories(2, {
          tier: Tier.WARM,
          created_at: now.toISOString(),
          last_accessed_at: now.toISOString(),
        }),
        ...createTestMemories(1, {
          tier: Tier.COLD,
          created_at: now.toISOString(),
          last_accessed_at: now.toISOString(),
        }),
      ];

      const result = allocator.allocate(memories, new Map(), now);

      // Should match actual selections
      const actualPinned = result.selected.filter(
        (sm) => sm.memory.pinned
      ).length;
      const actualHot = result.selected.filter(
        (sm) => !sm.memory.pinned && sm.memory.tier === Tier.HOT
      ).length;
      const actualWarm = result.selected.filter(
        (sm) => !sm.memory.pinned && sm.memory.tier === Tier.WARM
      ).length;
      const actualCold = result.selected.filter(
        (sm) => !sm.memory.pinned && sm.memory.tier === Tier.COLD
      ).length;

      expect(result.breakdown.pinned).toBe(actualPinned);
      expect(result.breakdown.hot).toBe(actualHot);
      expect(result.breakdown.warm).toBe(actualWarm);
      expect(result.breakdown.cold).toBe(actualCold);
    });

    it("should include scores in selected memories", () => {
      const now = new Date();
      const memories = createTestMemories(5, {
        tier: Tier.HOT,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const result = allocator.allocate(memories, new Map(), now);

      for (const sm of result.selected) {
        expect(typeof sm.score).toBe("number");
        expect(sm.score).toBeGreaterThanOrEqual(0);
        expect(sm.memory).toBeDefined();
      }
    });
  });

  describe("edge cases", () => {
    it("should handle empty memory list", () => {
      const result = allocator.allocate([], new Map(), new Date());

      expect(result.selected.length).toBe(0);
      expect(result.excludedCount).toBe(0);
      expect(result.totalConsidered).toBe(0);
      expect(result.breakdown).toEqual({ pinned: 0, hot: 0, warm: 0, cold: 0 });
    });

    it("should handle all memories excluded", () => {
      const memories = [
        ...createTestMemories(5, { tier: Tier.ARCHIVE }),
        ...createTestMemories(5, { do_not_inject: true, tier: Tier.HOT }),
      ];

      const result = allocator.allocate(memories, new Map(), new Date());

      expect(result.selected.length).toBe(0);
      expect(result.excludedCount).toBe(10);
      expect(result.totalConsidered).toBe(10);
    });

    it("should handle only pinned memories", () => {
      const now = new Date();
      const memories = createTestMemories(10, {
        pinned: true,
        tier: Tier.WARM,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const result = allocator.allocate(memories, new Map(), now);

      // With 20 maxItems and 25% pinned budget, we get 5 pinned slots
      expect(result.breakdown.pinned).toBe(5);
      expect(result.breakdown.hot).toBe(0);
      expect(result.breakdown.warm).toBe(0);
      expect(result.breakdown.cold).toBe(0);
      expect(result.selected.length).toBe(5);
    });

    it("should handle only COLD memories", () => {
      const now = new Date();
      const memories = createTestMemories(10, {
        tier: Tier.COLD,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const result = allocator.allocate(memories, new Map(), now);

      // With 20 maxItems and 5% cold budget, we get 1 cold slot
      expect(result.breakdown.cold).toBe(1);
      expect(result.selected.length).toBe(1);
    });

    it("should use reference time for scoring", () => {
      const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
      const memory = createTestMemory({
        tier: Tier.HOT,
        created_at: past.toISOString(),
        last_accessed_at: past.toISOString(),
      });

      const resultNow = allocator.allocate([memory], new Map(), new Date());
      const resultPast = allocator.allocate([memory], new Map(), past);

      // Score at past time should be higher (memory is "new" at that time)
      expect(resultPast.selected[0].score).toBeGreaterThan(
        resultNow.selected[0].score
      );
    });
  });

  describe("DEFAULT_ALLOCATOR_CONFIG constant", () => {
    it("should have correct default maxItems", () => {
      expect(DEFAULT_ALLOCATOR_CONFIG.maxItems).toBe(20);
    });

    it("should use DEFAULT_BUDGETS", () => {
      expect(DEFAULT_ALLOCATOR_CONFIG.budgets).toBe(DEFAULT_BUDGETS);
    });
  });
});
