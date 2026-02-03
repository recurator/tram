#!/usr/bin/env node
/**
 * TRAM Benchmark Runner
 *
 * Executes retrieval quality benchmarks comparing TRAM vs OpenClaw memory.
 * Computes: Precision@5, Precision@10, Recall@10, MRR, nDCG
 *
 * Conditions:
 *   - TRAM default (balanced weights)
 *   - TRAM similarity-heavy (0.8 similarity weight)
 *   - TRAM+minScore (with 0.3 minScore threshold)
 *   - OpenClaw default (vector-only simulation)
 *   - OpenClaw vector-only (pure vector search)
 */

import { randomUUID } from "crypto";
import { writeFileSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import BetterSqlite3, { type Database as SqliteDb } from "better-sqlite3";
import { Memory, MemoryType, Tier } from "../../core/types.js";
import { MemoryScorer, type ScoringWeights } from "../../core/scorer.js";
import { VectorHelper, type HybridSearchResult } from "../../db/vectors.js";
import { FTS5Helper } from "../../db/fts.js";

// ============================================================================
// Types
// ============================================================================

interface DatasetMemory {
  id: string;
  text: string;
  memory_type: MemoryType;
  ground_truth_queries: string[];
}

interface DatasetQuery {
  id: string;
  text: string;
  relevant_memory_ids: string[];
  category: string;
}

interface Dataset {
  description: string;
  version: string;
  created_at: string;
  memories: DatasetMemory[];
}

interface QuerySet {
  description: string;
  version: string;
  created_at: string;
  queries: DatasetQuery[];
}

interface TestCondition {
  name: string;
  description: string;
  scoringWeights: ScoringWeights;
  minScore: number;
  vectorWeight: number;
  textWeight: number;
}

interface MetricsResult {
  precisionAt5: number;
  precisionAt10: number;
  recallAt10: number;
  mrr: number;
  ndcg: number;
}

interface ConditionResult {
  condition: string;
  description: string;
  metrics: MetricsResult;
  queryResults: QueryResult[];
}

interface QueryResult {
  queryId: string;
  queryText: string;
  category: string;
  relevantIds: string[];
  retrievedIds: string[];
  precisionAt5: number;
  precisionAt10: number;
  recallAt10: number;
  reciprocalRank: number;
  ndcg: number;
}

interface BenchmarkResults {
  timestamp: string;
  datasetVersion: string;
  totalMemories: number;
  totalQueries: number;
  conditions: ConditionResult[];
  summary: SummaryStats;
}

interface SummaryStats {
  bestByPrecision5: { condition: string; value: number };
  bestByPrecision10: { condition: string; value: number };
  bestByRecall10: { condition: string; value: number };
  bestByMRR: { condition: string; value: number };
  bestByNDCG: { condition: string; value: number };
}

// ============================================================================
// Mock Embedding Provider (uses deterministic hash-based embeddings)
// ============================================================================

/**
 * Mock embedding provider that generates deterministic embeddings
 * based on text content. Uses a simple hashing approach to create
 * consistent embeddings for benchmarking purposes.
 */
class MockEmbeddingProvider {
  private dimensions: number;

  constructor(dimensions: number = 384) {
    this.dimensions = dimensions;
  }

  /**
   * Generate a deterministic embedding for text.
   * Uses character-based hashing to create reproducible vectors.
   */
  embed(text: string): number[] {
    const embedding = new Array(this.dimensions).fill(0);
    const normalizedText = text.toLowerCase();

    // Generate embedding based on character positions and n-grams
    for (let i = 0; i < normalizedText.length; i++) {
      const charCode = normalizedText.charCodeAt(i);
      const idx = (charCode * (i + 1)) % this.dimensions;
      embedding[idx] += 0.1;

      // Add bi-gram influence
      if (i < normalizedText.length - 1) {
        const nextChar = normalizedText.charCodeAt(i + 1);
        const bigramIdx = ((charCode * nextChar) + i) % this.dimensions;
        embedding[bigramIdx] += 0.05;
      }
    }

    // Add word-level features
    const words = normalizedText.split(/\s+/).filter((w) => w.length > 2);
    for (let w = 0; w < words.length; w++) {
      const word = words[w];
      let wordHash = 0;
      for (let c = 0; c < word.length; c++) {
        wordHash = (wordHash * 31 + word.charCodeAt(c)) % this.dimensions;
      }
      embedding[wordHash] += 0.2;
    }

    // Normalize the vector
    const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    if (norm > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= norm;
      }
    }

    return embedding;
  }

  getDimensions(): number {
    return this.dimensions;
  }
}

// ============================================================================
// Metrics Calculation
// ============================================================================

/**
 * Calculate Precision@K: fraction of retrieved items that are relevant
 */
function precisionAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  const topK = retrieved.slice(0, k);
  const hits = topK.filter((id) => relevant.has(id)).length;
  return hits / Math.min(k, topK.length || 1);
}

/**
 * Calculate Recall@K: fraction of relevant items that were retrieved
 */
function recallAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 1.0;
  const topK = retrieved.slice(0, k);
  const hits = topK.filter((id) => relevant.has(id)).length;
  return hits / relevant.size;
}

/**
 * Calculate Mean Reciprocal Rank: 1/rank of first relevant item
 */
function reciprocalRank(retrieved: string[], relevant: Set<string>): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Calculate Discounted Cumulative Gain at K
 */
function dcgAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  let dcg = 0;
  const topK = retrieved.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    const rel = relevant.has(topK[i]) ? 1 : 0;
    dcg += rel / Math.log2(i + 2); // i+2 because log2(1) = 0
  }
  return dcg;
}

/**
 * Calculate Ideal DCG at K (all relevant items at top)
 */
function idcgAtK(relevant: Set<string>, k: number): number {
  let idcg = 0;
  const numRelevant = Math.min(relevant.size, k);
  for (let i = 0; i < numRelevant; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg;
}

/**
 * Calculate Normalized Discounted Cumulative Gain at K
 */
function ndcgAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  const dcg = dcgAtK(retrieved, relevant, k);
  const idcg = idcgAtK(relevant, k);
  return idcg > 0 ? dcg / idcg : 0;
}

// ============================================================================
// Benchmark Database Setup
// ============================================================================

/**
 * Create an in-memory database with the benchmark dataset loaded.
 */
function createBenchmarkDatabase(
  dataset: Dataset,
  embeddingProvider: MockEmbeddingProvider
): { db: SqliteDb; vectorHelper: VectorHelper; ftsHelper: FTS5Helper } {
  // Create in-memory database
  const db = new BetterSqlite3(":memory:");

  // Initialize schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      category TEXT,
      created_at TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'HOT',
      memory_type TEXT NOT NULL DEFAULT 'factual',
      do_not_inject INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      use_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT NOT NULL,
      use_days TEXT NOT NULL DEFAULT '[]',
      source TEXT,
      parent_id TEXT
    )
  `);

  // Initialize FTS and Vector helpers
  const ftsHelper = new FTS5Helper(db);
  const vectorHelper = new VectorHelper(db, embeddingProvider.getDimensions(), ftsHelper);

  // Insert benchmark memories
  const now = new Date().toISOString();
  const insertStmt = db.prepare(`
    INSERT INTO memories (id, text, importance, category, created_at, tier, memory_type, do_not_inject, pinned, use_count, last_accessed_at, use_days)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, '[]')
  `);

  for (const memory of dataset.memories) {
    // Map importance based on memory type
    const importance =
      memory.memory_type === "procedural"
        ? 0.8
        : memory.memory_type === "factual"
          ? 0.7
          : memory.memory_type === "project"
            ? 0.6
            : 0.5;

    insertStmt.run(
      memory.id,
      memory.text,
      importance,
      memory.memory_type, // Use memory_type as category
      now,
      "HOT",
      memory.memory_type,
      now
    );

    // Store embedding
    const embedding = embeddingProvider.embed(memory.text);
    vectorHelper.storeEmbedding(memory.id, embedding);
  }

  return { db, vectorHelper, ftsHelper };
}

// ============================================================================
// Test Conditions
// ============================================================================

const TEST_CONDITIONS: TestCondition[] = [
  {
    name: "TRAM default",
    description: "Balanced weights: similarity 0.5, recency 0.3, frequency 0.2",
    scoringWeights: { similarity: 0.5, recency: 0.3, frequency: 0.2 },
    minScore: 0,
    vectorWeight: 0.7,
    textWeight: 0.3,
  },
  {
    name: "TRAM similarity-heavy",
    description: "Similarity-weighted: similarity 0.8, recency 0.1, frequency 0.1",
    scoringWeights: { similarity: 0.8, recency: 0.1, frequency: 0.1 },
    minScore: 0,
    vectorWeight: 0.8,
    textWeight: 0.2,
  },
  {
    name: "TRAM+minScore",
    description: "With minScore threshold 0.3 to filter low-relevance results",
    scoringWeights: { similarity: 0.5, recency: 0.3, frequency: 0.2 },
    minScore: 0.3,
    vectorWeight: 0.7,
    textWeight: 0.3,
  },
  {
    name: "OpenClaw default",
    description: "Simulated OpenClaw: equal vector/text weights, no TRAM scoring",
    scoringWeights: { similarity: 1.0, recency: 0, frequency: 0 },
    minScore: 0,
    vectorWeight: 0.5,
    textWeight: 0.5,
  },
  {
    name: "OpenClaw vector-only",
    description: "Pure vector search without text matching (simulates basic semantic search)",
    scoringWeights: { similarity: 1.0, recency: 0, frequency: 0 },
    minScore: 0,
    vectorWeight: 1.0,
    textWeight: 0,
  },
];

// ============================================================================
// Benchmark Runner
// ============================================================================

/**
 * Run retrieval for a single query under a specific condition.
 */
function runQuery(
  queryText: string,
  condition: TestCondition,
  db: SqliteDb,
  vectorHelper: VectorHelper,
  embeddingProvider: MockEmbeddingProvider,
  scorer: MemoryScorer
): string[] {
  // Generate query embedding
  const queryEmbedding = embeddingProvider.embed(queryText);

  // Run hybrid search
  const hybridResults = vectorHelper.hybridSearch(queryText, queryEmbedding, {
    limit: 30,
    vectorWeight: condition.vectorWeight,
    textWeight: condition.textWeight,
  });

  // Fetch memory details for scoring
  const memoryIds = hybridResults.map((r) => r.id);
  if (memoryIds.length === 0) return [];

  const placeholders = memoryIds.map(() => "?").join(", ");
  const stmt = db.prepare(`
    SELECT id, text, importance, category, created_at, tier, memory_type,
           do_not_inject, pinned, use_count, last_accessed_at, use_days
    FROM memories WHERE id IN (${placeholders})
  `);

  const rows = stmt.all(...memoryIds) as Array<{
    id: string;
    text: string;
    importance: number;
    category: string | null;
    created_at: string;
    tier: string;
    memory_type: string;
    do_not_inject: number;
    pinned: number;
    use_count: number;
    last_accessed_at: string;
    use_days: string;
  }>;

  // Create similarity map
  const similarityMap = new Map<string, number>();
  for (const result of hybridResults) {
    similarityMap.set(result.id, result.vectorScore);
  }

  // Score and rank memories
  const now = new Date();
  const scored: { id: string; score: number }[] = [];

  for (const row of rows) {
    const memory: Memory = {
      id: row.id,
      text: row.text,
      importance: row.importance,
      category: row.category,
      created_at: row.created_at,
      tier: row.tier as Tier,
      memory_type: row.memory_type as MemoryType,
      do_not_inject: row.do_not_inject === 1,
      pinned: row.pinned === 1,
      use_count: row.use_count,
      last_accessed_at: row.last_accessed_at,
      use_days: JSON.parse(row.use_days || "[]"),
      source: null,
      parent_id: null,
    };

    const similarity = similarityMap.get(row.id) ?? 0;
    const score = scorer.score(memory, similarity, now);

    // Apply minScore filter
    if (score >= condition.minScore) {
      scored.push({ id: row.id, score });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored.map((s) => s.id);
}

/**
 * Run benchmark for all conditions and queries.
 */
function runBenchmark(
  dataset: Dataset,
  querySet: QuerySet,
  embeddingProvider: MockEmbeddingProvider
): BenchmarkResults {
  const results: ConditionResult[] = [];

  for (const condition of TEST_CONDITIONS) {
    console.log(`\nRunning condition: ${condition.name}`);

    // Create fresh database for each condition
    const { db, vectorHelper } = createBenchmarkDatabase(dataset, embeddingProvider);
    const scorer = new MemoryScorer(condition.scoringWeights);

    const queryResults: QueryResult[] = [];

    for (const query of querySet.queries) {
      const relevantSet = new Set(query.relevant_memory_ids);
      const retrieved = runQuery(
        query.text,
        condition,
        db,
        vectorHelper,
        embeddingProvider,
        scorer
      );

      const p5 = precisionAtK(retrieved, relevantSet, 5);
      const p10 = precisionAtK(retrieved, relevantSet, 10);
      const r10 = recallAtK(retrieved, relevantSet, 10);
      const rr = reciprocalRank(retrieved, relevantSet);
      const ndcg = ndcgAtK(retrieved, relevantSet, 10);

      queryResults.push({
        queryId: query.id,
        queryText: query.text,
        category: query.category,
        relevantIds: query.relevant_memory_ids,
        retrievedIds: retrieved.slice(0, 10),
        precisionAt5: p5,
        precisionAt10: p10,
        recallAt10: r10,
        reciprocalRank: rr,
        ndcg: ndcg,
      });
    }

    // Calculate aggregate metrics
    const avgP5 = queryResults.reduce((sum, r) => sum + r.precisionAt5, 0) / queryResults.length;
    const avgP10 = queryResults.reduce((sum, r) => sum + r.precisionAt10, 0) / queryResults.length;
    const avgR10 = queryResults.reduce((sum, r) => sum + r.recallAt10, 0) / queryResults.length;
    const avgMRR = queryResults.reduce((sum, r) => sum + r.reciprocalRank, 0) / queryResults.length;
    const avgNDCG = queryResults.reduce((sum, r) => sum + r.ndcg, 0) / queryResults.length;

    results.push({
      condition: condition.name,
      description: condition.description,
      metrics: {
        precisionAt5: avgP5,
        precisionAt10: avgP10,
        recallAt10: avgR10,
        mrr: avgMRR,
        ndcg: avgNDCG,
      },
      queryResults,
    });

    db.close();
  }

  // Calculate summary statistics
  const summary: SummaryStats = {
    bestByPrecision5: findBest(results, (r) => r.metrics.precisionAt5),
    bestByPrecision10: findBest(results, (r) => r.metrics.precisionAt10),
    bestByRecall10: findBest(results, (r) => r.metrics.recallAt10),
    bestByMRR: findBest(results, (r) => r.metrics.mrr),
    bestByNDCG: findBest(results, (r) => r.metrics.ndcg),
  };

  return {
    timestamp: new Date().toISOString(),
    datasetVersion: dataset.version,
    totalMemories: dataset.memories.length,
    totalQueries: querySet.queries.length,
    conditions: results,
    summary,
  };
}

function findBest(
  results: ConditionResult[],
  getValue: (r: ConditionResult) => number
): { condition: string; value: number } {
  let best = results[0];
  for (const r of results) {
    if (getValue(r) > getValue(best)) {
      best = r;
    }
  }
  return { condition: best.condition, value: getValue(best) };
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printSummary(results: BenchmarkResults): void {
  console.log("\n" + "=".repeat(80));
  console.log("TRAM BENCHMARK RESULTS");
  console.log("=".repeat(80));
  console.log(`Timestamp: ${results.timestamp}`);
  console.log(`Dataset: ${results.totalMemories} memories, ${results.totalQueries} queries`);
  console.log();

  // Print metrics table header
  console.log("METRICS BY CONDITION:");
  console.log("-".repeat(80));
  console.log(
    "Condition".padEnd(25) +
      "P@5".padStart(10) +
      "P@10".padStart(10) +
      "R@10".padStart(10) +
      "MRR".padStart(10) +
      "nDCG".padStart(10)
  );
  console.log("-".repeat(80));

  for (const result of results.conditions) {
    console.log(
      result.condition.padEnd(25) +
        formatPercent(result.metrics.precisionAt5).padStart(10) +
        formatPercent(result.metrics.precisionAt10).padStart(10) +
        formatPercent(result.metrics.recallAt10).padStart(10) +
        formatPercent(result.metrics.mrr).padStart(10) +
        formatPercent(result.metrics.ndcg).padStart(10)
    );
  }
  console.log("-".repeat(80));
  console.log();

  // Print best performers
  console.log("BEST PERFORMERS:");
  console.log(`  Precision@5:  ${results.summary.bestByPrecision5.condition} (${formatPercent(results.summary.bestByPrecision5.value)})`);
  console.log(`  Precision@10: ${results.summary.bestByPrecision10.condition} (${formatPercent(results.summary.bestByPrecision10.value)})`);
  console.log(`  Recall@10:    ${results.summary.bestByRecall10.condition} (${formatPercent(results.summary.bestByRecall10.value)})`);
  console.log(`  MRR:          ${results.summary.bestByMRR.condition} (${formatPercent(results.summary.bestByMRR.value)})`);
  console.log(`  nDCG:         ${results.summary.bestByNDCG.condition} (${formatPercent(results.summary.bestByNDCG.value)})`);
  console.log();

  // Print category breakdown for best TRAM condition
  const bestTram = results.conditions.find((c) => c.condition === results.summary.bestByNDCG.condition);
  if (bestTram) {
    console.log(`CATEGORY BREAKDOWN (${bestTram.condition}):`);
    console.log("-".repeat(60));

    // Group by category
    const byCategory = new Map<string, QueryResult[]>();
    for (const qr of bestTram.queryResults) {
      const cat = qr.category.split("-")[0]; // Get base category
      if (!byCategory.has(cat)) {
        byCategory.set(cat, []);
      }
      byCategory.get(cat)!.push(qr);
    }

    for (const [category, queries] of byCategory) {
      const avgP10 = queries.reduce((sum, q) => sum + q.precisionAt10, 0) / queries.length;
      const avgR10 = queries.reduce((sum, q) => sum + q.recallAt10, 0) / queries.length;
      const avgNDCG = queries.reduce((sum, q) => sum + q.ndcg, 0) / queries.length;
      console.log(
        `  ${category.padEnd(15)} P@10: ${formatPercent(avgP10).padStart(7)}  R@10: ${formatPercent(avgR10).padStart(7)}  nDCG: ${formatPercent(avgNDCG).padStart(7)}`
      );
    }
    console.log();
  }

  console.log("=".repeat(80));
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const currentDir = dirname(fileURLToPath(import.meta.url));

  // Load dataset and queries
  const datasetPath = join(currentDir, "dataset.json");
  const queriesPath = join(currentDir, "queries.json");
  const resultsPath = join(currentDir, "results.json");

  console.log("Loading benchmark data...");
  const dataset: Dataset = JSON.parse(readFileSync(datasetPath, "utf-8"));
  const querySet: QuerySet = JSON.parse(readFileSync(queriesPath, "utf-8"));

  console.log(`Loaded ${dataset.memories.length} memories and ${querySet.queries.length} queries`);

  // Initialize mock embedding provider
  const embeddingProvider = new MockEmbeddingProvider(384);

  // Run benchmark
  console.log("\nRunning benchmark...");
  const results = runBenchmark(dataset, querySet, embeddingProvider);

  // Output results
  printSummary(results);

  // Write results to JSON file
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`\nDetailed results written to: ${resultsPath}`);
}

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});
