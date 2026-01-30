/**
 * Local embedding provider using @xenova/transformers for fully offline inference.
 * Default model: Xenova/all-MiniLM-L6-v2 (384 dimensions, good balance of speed/quality)
 */

import type { EmbeddingProvider } from "./provider.js";

// Default model for local embeddings
const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_DIMENSIONS = 384;

// Model dimension mapping for common models
const MODEL_DIMENSIONS: Record<string, number> = {
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/all-MiniLM-L12-v2": 384,
  "Xenova/paraphrase-MiniLM-L6-v2": 384,
  "Xenova/all-mpnet-base-v2": 768,
  "Xenova/gte-small": 384,
  "Xenova/gte-base": 768,
  "Xenova/e5-small-v2": 384,
  "Xenova/e5-base-v2": 768,
};

/**
 * Configuration options for the local embedding provider.
 */
export interface LocalEmbeddingConfig {
  /**
   * Path to the model (Hugging Face model ID or local path).
   * Defaults to Xenova/all-MiniLM-L6-v2 if not specified.
   */
  modelPath?: string;
}

/**
 * Local embedding provider using @xenova/transformers for offline inference.
 * Caches the loaded model pipeline for performance.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  private modelPath: string;
  private dimensions: number;
  private pipeline: unknown | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(config?: LocalEmbeddingConfig) {
    this.modelPath = config?.modelPath ?? DEFAULT_MODEL;
    this.dimensions = MODEL_DIMENSIONS[this.modelPath] ?? DEFAULT_DIMENSIONS;
  }

  /**
   * Initialize the model pipeline. Called lazily on first embed call.
   * Uses dynamic import to load transformers.js only when needed.
   */
  private async initialize(): Promise<void> {
    if (this.pipeline !== null) {
      return;
    }

    // Use initPromise to prevent multiple concurrent initializations
    if (this.initPromise !== null) {
      return this.initPromise;
    }

    this.initPromise = this.loadPipeline();
    await this.initPromise;
  }

  private async loadPipeline(): Promise<void> {
    try {
      // Dynamic import of @xenova/transformers
      const { pipeline } = await import("@xenova/transformers");

      // Create the feature-extraction pipeline for embeddings
      this.pipeline = await pipeline("feature-extraction", this.modelPath, {
        // Use fp32 for better precision on CPU
        quantized: true,
      });
    } catch (error) {
      // Clear init promise so retries can happen
      this.initPromise = null;

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load local embedding model '${this.modelPath}': ${message}. ` +
        `Ensure the model exists and @xenova/transformers is installed. ` +
        `Try: npm install @xenova/transformers`
      );
    }
  }

  async embed(text: string): Promise<number[]> {
    await this.initialize();

    try {
      // Type assertion since we know the pipeline is a function after initialization
      const output = await (this.pipeline as (input: string, options: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array | number[] }>)(
        text,
        { pooling: "mean", normalize: true }
      );

      // Convert Float32Array or nested array to flat number array
      const data = output.data;
      return Array.from(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Embedding generation failed: ${message}`);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    await this.initialize();

    if (texts.length === 0) {
      return [];
    }

    try {
      // Process texts in batch for better efficiency
      const output = await (this.pipeline as (inputs: string[], options: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array | number[]; dims: number[] }>)(
        texts,
        { pooling: "mean", normalize: true }
      );

      // Output has shape [batch_size, dimensions]
      const batchSize = texts.length;
      const dims = this.dimensions;
      const results: number[][] = [];

      for (let i = 0; i < batchSize; i++) {
        const start = i * dims;
        const end = start + dims;
        results.push(Array.from(output.data.slice(start, end)));
      }

      return results;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Batch embedding generation failed: ${message}`);
    }
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModelName(): string {
    return this.modelPath;
  }
}
