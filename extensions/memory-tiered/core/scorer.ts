/**
 * MemoryScorer - Composite scoring for memory relevance
 *
 * Score formula:
 *   score = w_sim * similarity + w_rec * exp(-effective_age / half_life) + w_freq * log(1 + use_count)
 *
 * Where:
 *   - effective_age = now - max(created_at, last_accessed_at)
 *   - half_life depends on memory_type (procedural: 180d, factual: 90d, project: 45d, episodic: 10d)
 *   - pinned memories have infinite half-life (recency component = 1)
 *   - COLD tier applies 0.5x recency adjustment
 *   - ARCHIVE tier returns score = 0
 */

import { Memory, MemoryType, Tier } from "./types.js";

/**
 * Half-life values in days for each memory type
 */
export const HALF_LIVES: Record<MemoryType, number> = {
  [MemoryType.procedural]: 180,
  [MemoryType.factual]: 90,
  [MemoryType.project]: 45,
  [MemoryType.episodic]: 10,
};

/**
 * Default scoring weights
 */
export interface ScoringWeights {
  /** Weight for similarity component (default: 0.5) */
  similarity: number;
  /** Weight for recency component (default: 0.3) */
  recency: number;
  /** Weight for frequency component (default: 0.2) */
  frequency: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  similarity: 0.5,
  recency: 0.3,
  frequency: 0.2,
};

/**
 * Detailed breakdown of score components
 */
export interface ScoreBreakdown {
  /** Similarity component contribution */
  similarityComponent: number;
  /** Recency component contribution */
  recencyComponent: number;
  /** Frequency component contribution */
  frequencyComponent: number;
  /** Final combined score */
  totalScore: number;
  /** Effective age in days */
  effectiveAgeDays: number;
  /** Half-life used for calculation */
  halfLifeDays: number;
}

/**
 * Memory scorer with configurable weights
 */
export class MemoryScorer {
  private weights: ScoringWeights;

  constructor(weights: Partial<ScoringWeights> = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  /**
   * Calculate composite score for a memory
   * @param memory The memory to score
   * @param similarity Optional similarity score (0-1) from search, defaults to 1
   * @param now Reference time for age calculations (default: current time)
   * @returns The composite score (0-1)
   */
  score(memory: Memory, similarity: number = 1, now: Date = new Date()): number {
    // ARCHIVE tier always returns 0
    if (memory.tier === Tier.ARCHIVE) {
      return 0;
    }

    const breakdown = this.scoreWithBreakdown(memory, similarity, now);
    return breakdown.totalScore;
  }

  /**
   * Calculate composite score with detailed breakdown
   * @param memory The memory to score
   * @param similarity Optional similarity score (0-1) from search, defaults to 1
   * @param now Reference time for age calculations (default: current time)
   * @returns Score breakdown with all components
   */
  scoreWithBreakdown(
    memory: Memory,
    similarity: number = 1,
    now: Date = new Date()
  ): ScoreBreakdown {
    // ARCHIVE tier returns zero breakdown
    if (memory.tier === Tier.ARCHIVE) {
      return {
        similarityComponent: 0,
        recencyComponent: 0,
        frequencyComponent: 0,
        totalScore: 0,
        effectiveAgeDays: this.calculateEffectiveAgeDays(memory, now),
        halfLifeDays: this.getHalfLife(memory),
      };
    }

    // Calculate effective age: now - max(created_at, last_accessed_at)
    const effectiveAgeDays = this.calculateEffectiveAgeDays(memory, now);

    // Get half-life for this memory type
    const halfLifeDays = this.getHalfLife(memory);

    // Calculate similarity component
    const similarityComponent = this.weights.similarity * similarity;

    // Calculate recency component: exp(-effective_age / half_life)
    let recencyValue: number;
    if (memory.pinned) {
      // Pinned memories have infinite half-life (never decay)
      recencyValue = 1;
    } else {
      recencyValue = Math.exp(-effectiveAgeDays / halfLifeDays);
    }

    // Apply COLD tier adjustment: recency * 0.5
    if (memory.tier === Tier.COLD) {
      recencyValue *= 0.5;
    }

    const recencyComponent = this.weights.recency * recencyValue;

    // Calculate frequency component: log(1 + use_count)
    const frequencyValue = Math.log(1 + memory.use_count);
    // Normalize frequency: log(1+n) grows slowly, cap for reasonable weighting
    // Using log(1+100)=4.6 as approximate max for normalization
    const normalizedFrequency = Math.min(frequencyValue / 4.6, 1);
    const frequencyComponent = this.weights.frequency * normalizedFrequency;

    const totalScore = similarityComponent + recencyComponent + frequencyComponent;

    return {
      similarityComponent,
      recencyComponent,
      frequencyComponent,
      totalScore,
      effectiveAgeDays,
      halfLifeDays,
    };
  }

  /**
   * Calculate effective age in days
   */
  private calculateEffectiveAgeDays(memory: Memory, now: Date): number {
    const createdAt = new Date(memory.created_at);
    const lastAccessedAt = new Date(memory.last_accessed_at);
    const moreRecentDate = createdAt > lastAccessedAt ? createdAt : lastAccessedAt;
    const ageDiffMs = now.getTime() - moreRecentDate.getTime();
    return ageDiffMs / (1000 * 60 * 60 * 24);
  }

  /**
   * Get half-life for a memory based on its type
   */
  private getHalfLife(memory: Memory): number {
    return HALF_LIVES[memory.memory_type];
  }

  /**
   * Get the current scoring weights
   */
  getWeights(): ScoringWeights {
    return { ...this.weights };
  }

  /**
   * Update scoring weights
   */
  setWeights(weights: Partial<ScoringWeights>): void {
    this.weights = { ...this.weights, ...weights };
  }
}
