/**
 * Unit tests for MemoryScorer
 *
 * Tests the composite scoring formula:
 *   score = w_sim * similarity + w_rec * exp(-effective_age / half_life) + w_freq * log(1 + use_count)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  MemoryScorer,
  HALF_LIVES,
  DEFAULT_WEIGHTS,
  type ScoringWeights,
} from "../core/scorer.js";
import { Memory, MemoryType, Tier } from "../core/types.js";

/**
 * Create a test memory with sensible defaults
 */
function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date().toISOString();
  return {
    id: "test-memory-id",
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
 * Create a date N days in the past
 */
function daysAgo(days: number, from: Date = new Date()): Date {
  const date = new Date(from);
  date.setDate(date.getDate() - days);
  return date;
}

describe("MemoryScorer", () => {
  let scorer: MemoryScorer;

  beforeEach(() => {
    scorer = new MemoryScorer();
  });

  describe("constructor and weights", () => {
    it("should use default weights when none provided", () => {
      const weights = scorer.getWeights();
      expect(weights).toEqual(DEFAULT_WEIGHTS);
    });

    it("should allow custom weights", () => {
      const customWeights: Partial<ScoringWeights> = {
        similarity: 0.6,
        recency: 0.2,
        frequency: 0.2,
      };
      const customScorer = new MemoryScorer(customWeights);
      expect(customScorer.getWeights()).toEqual({
        similarity: 0.6,
        recency: 0.2,
        frequency: 0.2,
      });
    });

    it("should allow partial weight overrides", () => {
      const customScorer = new MemoryScorer({ similarity: 0.7 });
      const weights = customScorer.getWeights();
      expect(weights.similarity).toBe(0.7);
      expect(weights.recency).toBe(DEFAULT_WEIGHTS.recency);
      expect(weights.frequency).toBe(DEFAULT_WEIGHTS.frequency);
    });

    it("should allow updating weights via setWeights", () => {
      scorer.setWeights({ similarity: 0.8 });
      expect(scorer.getWeights().similarity).toBe(0.8);
    });
  });

  describe("similarity component", () => {
    it("should calculate similarity component correctly", () => {
      const memory = createTestMemory();
      const now = new Date(memory.created_at);

      // With similarity = 1.0 and default weight 0.5
      const breakdown = scorer.scoreWithBreakdown(memory, 1.0, now);
      expect(breakdown.similarityComponent).toBeCloseTo(0.5, 5);

      // With similarity = 0.5
      const breakdown2 = scorer.scoreWithBreakdown(memory, 0.5, now);
      expect(breakdown2.similarityComponent).toBeCloseTo(0.25, 5);

      // With similarity = 0.0
      const breakdown3 = scorer.scoreWithBreakdown(memory, 0.0, now);
      expect(breakdown3.similarityComponent).toBe(0);
    });

    it("should scale similarity with custom weights", () => {
      const customScorer = new MemoryScorer({ similarity: 0.8 });
      const memory = createTestMemory();
      const now = new Date(memory.created_at);

      const breakdown = customScorer.scoreWithBreakdown(memory, 1.0, now);
      expect(breakdown.similarityComponent).toBeCloseTo(0.8, 5);
    });

    it("should default similarity to 1.0 when not provided", () => {
      const memory = createTestMemory();
      const now = new Date(memory.created_at);

      const score = scorer.score(memory, undefined, now);
      const breakdown = scorer.scoreWithBreakdown(memory, 1.0, now);
      expect(score).toBeCloseTo(breakdown.totalScore, 5);
    });
  });

  describe("recency component with different ages", () => {
    it("should give full recency score for brand new memories", () => {
      const memory = createTestMemory({ memory_type: MemoryType.factual });
      const now = new Date(memory.created_at);

      const breakdown = scorer.scoreWithBreakdown(memory, 1.0, now);
      // exp(-0/90) = exp(0) = 1, so recencyComponent = 0.3 * 1 = 0.3
      expect(breakdown.effectiveAgeDays).toBeCloseTo(0, 3);
      expect(breakdown.recencyComponent).toBeCloseTo(0.3, 5);
    });

    it("should halve recency score at half-life age for factual memories", () => {
      const halfLife = HALF_LIVES[MemoryType.factual]; // 90 days
      const now = new Date();
      const createdAt = daysAgo(halfLife, now);
      const memory = createTestMemory({
        memory_type: MemoryType.factual,
        created_at: createdAt.toISOString(),
        last_accessed_at: createdAt.toISOString(),
      });

      const breakdown = scorer.scoreWithBreakdown(memory, 1.0, now);
      // exp(-90/90) = exp(-1) ≈ 0.3679
      expect(breakdown.effectiveAgeDays).toBeCloseTo(halfLife, 1);
      expect(breakdown.recencyComponent).toBeCloseTo(
        0.3 * Math.exp(-1),
        3
      );
    });

    it("should use different half-lives for different memory types", () => {
      const now = new Date();

      // Test procedural (180 days half-life)
      const proceduralMemory = createTestMemory({
        memory_type: MemoryType.procedural,
        created_at: daysAgo(90, now).toISOString(),
        last_accessed_at: daysAgo(90, now).toISOString(),
      });
      const proceduralBreakdown = scorer.scoreWithBreakdown(
        proceduralMemory,
        1.0,
        now
      );
      expect(proceduralBreakdown.halfLifeDays).toBe(180);
      // exp(-90/180) = exp(-0.5) ≈ 0.6065
      expect(proceduralBreakdown.recencyComponent).toBeCloseTo(
        0.3 * Math.exp(-0.5),
        3
      );

      // Test project (45 days half-life)
      const projectMemory = createTestMemory({
        memory_type: MemoryType.project,
        created_at: daysAgo(45, now).toISOString(),
        last_accessed_at: daysAgo(45, now).toISOString(),
      });
      const projectBreakdown = scorer.scoreWithBreakdown(
        projectMemory,
        1.0,
        now
      );
      expect(projectBreakdown.halfLifeDays).toBe(45);
      expect(projectBreakdown.recencyComponent).toBeCloseTo(
        0.3 * Math.exp(-1),
        3
      );

      // Test episodic (10 days half-life)
      const episodicMemory = createTestMemory({
        memory_type: MemoryType.episodic,
        created_at: daysAgo(10, now).toISOString(),
        last_accessed_at: daysAgo(10, now).toISOString(),
      });
      const episodicBreakdown = scorer.scoreWithBreakdown(
        episodicMemory,
        1.0,
        now
      );
      expect(episodicBreakdown.halfLifeDays).toBe(10);
      expect(episodicBreakdown.recencyComponent).toBeCloseTo(
        0.3 * Math.exp(-1),
        3
      );
    });

    it("should calculate effective age from max(created_at, last_accessed_at)", () => {
      const now = new Date();
      const createdAt = daysAgo(30, now);
      const lastAccessedAt = daysAgo(10, now); // More recent

      const memory = createTestMemory({
        created_at: createdAt.toISOString(),
        last_accessed_at: lastAccessedAt.toISOString(),
      });

      const breakdown = scorer.scoreWithBreakdown(memory, 1.0, now);
      // Should use last_accessed_at (10 days ago) since it's more recent
      expect(breakdown.effectiveAgeDays).toBeCloseTo(10, 1);
    });

    it("should use created_at if last_accessed_at is earlier", () => {
      const now = new Date();
      const createdAt = daysAgo(10, now);
      const lastAccessedAt = daysAgo(30, now); // Older (can happen if dates are set incorrectly)

      const memory = createTestMemory({
        created_at: createdAt.toISOString(),
        last_accessed_at: lastAccessedAt.toISOString(),
      });

      const breakdown = scorer.scoreWithBreakdown(memory, 1.0, now);
      // Should use created_at (10 days ago) since it's more recent
      expect(breakdown.effectiveAgeDays).toBeCloseTo(10, 1);
    });

    it("should decay recency score exponentially over time", () => {
      const now = new Date();
      const halfLife = HALF_LIVES[MemoryType.factual]; // 90 days

      // Memory at 0 days
      const memory0 = createTestMemory({
        memory_type: MemoryType.factual,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });
      const score0 = scorer.scoreWithBreakdown(memory0, 1.0, now).recencyComponent;

      // Memory at 1 half-life (90 days)
      const memory1 = createTestMemory({
        memory_type: MemoryType.factual,
        created_at: daysAgo(halfLife, now).toISOString(),
        last_accessed_at: daysAgo(halfLife, now).toISOString(),
      });
      const score1 = scorer.scoreWithBreakdown(memory1, 1.0, now).recencyComponent;

      // Memory at 2 half-lives (180 days)
      const memory2 = createTestMemory({
        memory_type: MemoryType.factual,
        created_at: daysAgo(halfLife * 2, now).toISOString(),
        last_accessed_at: daysAgo(halfLife * 2, now).toISOString(),
      });
      const score2 = scorer.scoreWithBreakdown(memory2, 1.0, now).recencyComponent;

      // Exponential decay: score1 ≈ score0 / e, score2 ≈ score0 / e^2
      expect(score0).toBeCloseTo(0.3, 3);
      expect(score1).toBeCloseTo(score0 / Math.E, 3);
      expect(score2).toBeCloseTo(score0 / (Math.E * Math.E), 3);
    });
  });

  describe("frequency component with different use_counts", () => {
    it("should give zero frequency score for use_count = 0", () => {
      const memory = createTestMemory({ use_count: 0 });
      const now = new Date(memory.created_at);

      const breakdown = scorer.scoreWithBreakdown(memory, 1.0, now);
      // log(1 + 0) = log(1) = 0
      expect(breakdown.frequencyComponent).toBe(0);
    });

    it("should calculate frequency component for various use_counts", () => {
      const now = new Date();

      // use_count = 1: log(2) / 4.6 ≈ 0.151, * 0.2 ≈ 0.030
      const memory1 = createTestMemory({
        use_count: 1,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });
      const breakdown1 = scorer.scoreWithBreakdown(memory1, 1.0, now);
      expect(breakdown1.frequencyComponent).toBeCloseTo(
        0.2 * (Math.log(2) / 4.6),
        4
      );

      // use_count = 10: log(11) / 4.6 ≈ 0.521, * 0.2 ≈ 0.104
      const memory10 = createTestMemory({
        use_count: 10,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });
      const breakdown10 = scorer.scoreWithBreakdown(memory10, 1.0, now);
      expect(breakdown10.frequencyComponent).toBeCloseTo(
        0.2 * (Math.log(11) / 4.6),
        4
      );

      // use_count = 100: log(101) / 4.6 ≈ 1.0, * 0.2 = 0.2 (capped)
      const memory100 = createTestMemory({
        use_count: 100,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });
      const breakdown100 = scorer.scoreWithBreakdown(memory100, 1.0, now);
      expect(breakdown100.frequencyComponent).toBeCloseTo(0.2, 3);
    });

    it("should cap frequency component at weight limit", () => {
      const now = new Date();

      // Very high use_count should still cap at 0.2 (default frequency weight)
      const memoryHigh = createTestMemory({
        use_count: 1000,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });
      const breakdown = scorer.scoreWithBreakdown(memoryHigh, 1.0, now);
      // Math.min(log(1001)/4.6, 1) = 1, so frequencyComponent = 0.2
      expect(breakdown.frequencyComponent).toBeLessThanOrEqual(0.2);
    });

    it("should scale frequency with custom weights", () => {
      const customScorer = new MemoryScorer({ frequency: 0.4 });
      const now = new Date();

      const memory = createTestMemory({
        use_count: 100,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });
      const breakdown = customScorer.scoreWithBreakdown(memory, 1.0, now);
      expect(breakdown.frequencyComponent).toBeCloseTo(0.4, 3);
    });
  });

  describe("tier adjustments", () => {
    it("should apply 0.5x recency adjustment for COLD tier", () => {
      const now = new Date();
      const memory = createTestMemory({
        tier: Tier.COLD,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const breakdown = scorer.scoreWithBreakdown(memory, 1.0, now);
      // For a new memory, recency value is 1.0 * 0.5 = 0.5
      // recencyComponent = 0.3 * 0.5 = 0.15
      expect(breakdown.recencyComponent).toBeCloseTo(0.15, 5);
    });

    it("should not apply COLD adjustment to HOT tier", () => {
      const now = new Date();
      const memory = createTestMemory({
        tier: Tier.HOT,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const breakdown = scorer.scoreWithBreakdown(memory, 1.0, now);
      expect(breakdown.recencyComponent).toBeCloseTo(0.3, 5);
    });

    it("should not apply COLD adjustment to WARM tier", () => {
      const now = new Date();
      const memory = createTestMemory({
        tier: Tier.WARM,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const breakdown = scorer.scoreWithBreakdown(memory, 1.0, now);
      expect(breakdown.recencyComponent).toBeCloseTo(0.3, 5);
    });

    it("should return score = 0 for ARCHIVE tier", () => {
      const now = new Date();
      const memory = createTestMemory({
        tier: Tier.ARCHIVE,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
        use_count: 100, // Even with high use
      });

      const score = scorer.score(memory, 1.0, now);
      expect(score).toBe(0);
    });

    it("should return zero breakdown for ARCHIVE tier", () => {
      const now = new Date();
      const memory = createTestMemory({
        tier: Tier.ARCHIVE,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const breakdown = scorer.scoreWithBreakdown(memory, 1.0, now);
      expect(breakdown.similarityComponent).toBe(0);
      expect(breakdown.recencyComponent).toBe(0);
      expect(breakdown.frequencyComponent).toBe(0);
      expect(breakdown.totalScore).toBe(0);
      // But should still calculate age and half-life for explanation purposes
      expect(breakdown.effectiveAgeDays).toBeCloseTo(0, 3);
      expect(breakdown.halfLifeDays).toBe(HALF_LIVES[memory.memory_type]);
    });

    it("should apply both COLD adjustment and age decay", () => {
      const now = new Date();
      const halfLife = HALF_LIVES[MemoryType.factual]; // 90 days
      const createdAt = daysAgo(halfLife, now);

      const memory = createTestMemory({
        tier: Tier.COLD,
        memory_type: MemoryType.factual,
        created_at: createdAt.toISOString(),
        last_accessed_at: createdAt.toISOString(),
      });

      const breakdown = scorer.scoreWithBreakdown(memory, 1.0, now);
      // recencyValue = exp(-1) * 0.5 ≈ 0.184
      // recencyComponent = 0.3 * 0.184 ≈ 0.055
      const expectedRecencyValue = Math.exp(-1) * 0.5;
      expect(breakdown.recencyComponent).toBeCloseTo(
        0.3 * expectedRecencyValue,
        3
      );
    });
  });

  describe("pinned memories (infinite half-life)", () => {
    it("should give full recency score for pinned memories regardless of age", () => {
      const now = new Date();
      const createdAt = daysAgo(365, now); // 1 year old

      const memory = createTestMemory({
        pinned: true,
        created_at: createdAt.toISOString(),
        last_accessed_at: createdAt.toISOString(),
      });

      const breakdown = scorer.scoreWithBreakdown(memory, 1.0, now);
      // Pinned = infinite half-life, recencyValue = 1
      expect(breakdown.recencyComponent).toBeCloseTo(0.3, 5);
    });

    it("should still have correct effective age for pinned memories", () => {
      const now = new Date();
      const createdAt = daysAgo(100, now);

      const memory = createTestMemory({
        pinned: true,
        created_at: createdAt.toISOString(),
        last_accessed_at: createdAt.toISOString(),
      });

      const breakdown = scorer.scoreWithBreakdown(memory, 1.0, now);
      expect(breakdown.effectiveAgeDays).toBeCloseTo(100, 1);
      // But recency is still 1 because pinned
      expect(breakdown.recencyComponent).toBeCloseTo(0.3, 5);
    });

    it("should not apply COLD tier adjustment to pinned memories", () => {
      const now = new Date();

      // Regular COLD memory
      const coldMemory = createTestMemory({
        tier: Tier.COLD,
        pinned: false,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      // Pinned COLD memory
      const pinnedColdMemory = createTestMemory({
        tier: Tier.COLD,
        pinned: true,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const coldBreakdown = scorer.scoreWithBreakdown(coldMemory, 1.0, now);
      const pinnedBreakdown = scorer.scoreWithBreakdown(
        pinnedColdMemory,
        1.0,
        now
      );

      // COLD unpinned: recencyValue = 1 * 0.5 = 0.5
      expect(coldBreakdown.recencyComponent).toBeCloseTo(0.15, 5);
      // COLD pinned: recencyValue = 1, then * 0.5 = 0.5
      // (COLD adjustment still applies to pinned)
      expect(pinnedBreakdown.recencyComponent).toBeCloseTo(0.15, 5);
    });

    it("should still have all other components for pinned memories", () => {
      const now = new Date();
      const memory = createTestMemory({
        pinned: true,
        use_count: 50,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const breakdown = scorer.scoreWithBreakdown(memory, 0.8, now);
      expect(breakdown.similarityComponent).toBeCloseTo(0.4, 5); // 0.5 * 0.8
      expect(breakdown.recencyComponent).toBeCloseTo(0.3, 5); // pinned = 1
      expect(breakdown.frequencyComponent).toBeGreaterThan(0);
    });
  });

  describe("combined score calculation", () => {
    it("should sum all components correctly", () => {
      const now = new Date();
      const memory = createTestMemory({
        use_count: 10,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const breakdown = scorer.scoreWithBreakdown(memory, 0.8, now);

      const manualTotal =
        breakdown.similarityComponent +
        breakdown.recencyComponent +
        breakdown.frequencyComponent;

      expect(breakdown.totalScore).toBeCloseTo(manualTotal, 10);
    });

    it("should match score() and scoreWithBreakdown().totalScore", () => {
      const now = new Date();
      const memory = createTestMemory({
        tier: Tier.WARM,
        use_count: 25,
        created_at: daysAgo(30, now).toISOString(),
        last_accessed_at: daysAgo(5, now).toISOString(),
      });

      const score = scorer.score(memory, 0.7, now);
      const breakdown = scorer.scoreWithBreakdown(memory, 0.7, now);

      expect(score).toBeCloseTo(breakdown.totalScore, 10);
    });

    it("should produce maximum score close to 1.0 for optimal memory", () => {
      const now = new Date();
      const memory = createTestMemory({
        tier: Tier.HOT,
        pinned: true,
        use_count: 100,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const score = scorer.score(memory, 1.0, now);
      // similarity: 0.5, recency: 0.3, frequency: 0.2 (capped) = 1.0
      expect(score).toBeCloseTo(1.0, 2);
    });

    it("should produce minimum score close to 0.0 for ARCHIVE tier", () => {
      const now = new Date();
      const memory = createTestMemory({
        tier: Tier.ARCHIVE,
        use_count: 100,
        created_at: daysAgo(1, now).toISOString(),
        last_accessed_at: daysAgo(1, now).toISOString(),
      });

      const score = scorer.score(memory, 1.0, now);
      expect(score).toBe(0);
    });

    it("should handle edge case of very old unpinned memory", () => {
      const now = new Date();
      const memory = createTestMemory({
        tier: Tier.HOT,
        pinned: false,
        use_count: 0,
        memory_type: MemoryType.episodic, // 10-day half-life
        created_at: daysAgo(365, now).toISOString(),
        last_accessed_at: daysAgo(365, now).toISOString(),
      });

      const breakdown = scorer.scoreWithBreakdown(memory, 0.5, now);

      // Similarity: 0.5 * 0.5 = 0.25
      expect(breakdown.similarityComponent).toBeCloseTo(0.25, 5);

      // Recency: exp(-365/10) ≈ 0 (effectively)
      expect(breakdown.recencyComponent).toBeLessThan(0.001);

      // Frequency: 0
      expect(breakdown.frequencyComponent).toBe(0);

      // Total should be dominated by similarity
      expect(breakdown.totalScore).toBeCloseTo(0.25, 2);
    });

    it("should correctly order memories by score", () => {
      const now = new Date();

      const lowScore = createTestMemory({
        tier: Tier.COLD,
        use_count: 0,
        created_at: daysAgo(180, now).toISOString(),
        last_accessed_at: daysAgo(180, now).toISOString(),
      });

      const midScore = createTestMemory({
        tier: Tier.WARM,
        use_count: 10,
        created_at: daysAgo(30, now).toISOString(),
        last_accessed_at: daysAgo(5, now).toISOString(),
      });

      const highScore = createTestMemory({
        tier: Tier.HOT,
        pinned: true,
        use_count: 50,
        created_at: now.toISOString(),
        last_accessed_at: now.toISOString(),
      });

      const scores = [
        scorer.score(lowScore, 0.5, now),
        scorer.score(midScore, 0.7, now),
        scorer.score(highScore, 0.9, now),
      ];

      // Verify ordering
      expect(scores[0]).toBeLessThan(scores[1]);
      expect(scores[1]).toBeLessThan(scores[2]);
    });
  });

  describe("HALF_LIVES constant", () => {
    it("should have correct half-lives for all memory types", () => {
      expect(HALF_LIVES[MemoryType.procedural]).toBe(180);
      expect(HALF_LIVES[MemoryType.factual]).toBe(90);
      expect(HALF_LIVES[MemoryType.project]).toBe(45);
      expect(HALF_LIVES[MemoryType.episodic]).toBe(10);
    });

    it("should cover all memory types", () => {
      const memoryTypes = Object.values(MemoryType);
      for (const type of memoryTypes) {
        expect(HALF_LIVES[type]).toBeDefined();
        expect(typeof HALF_LIVES[type]).toBe("number");
        expect(HALF_LIVES[type]).toBeGreaterThan(0);
      }
    });
  });

  describe("DEFAULT_WEIGHTS constant", () => {
    it("should have weights that sum to 1.0", () => {
      const sum =
        DEFAULT_WEIGHTS.similarity +
        DEFAULT_WEIGHTS.recency +
        DEFAULT_WEIGHTS.frequency;
      expect(sum).toBeCloseTo(1.0, 10);
    });

    it("should have correct default values", () => {
      expect(DEFAULT_WEIGHTS.similarity).toBe(0.5);
      expect(DEFAULT_WEIGHTS.recency).toBe(0.3);
      expect(DEFAULT_WEIGHTS.frequency).toBe(0.2);
    });
  });
});
