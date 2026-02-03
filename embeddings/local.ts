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
    // Validate input
    if (!text || typeof text !== "string") {
      throw new Error("Embedding input must be a non-empty string");
    }
    const trimmedText = text.trim();
    if (trimmedText.length === 0) {
      throw new Error("Embedding input cannot be empty or whitespace-only");
    }

    await this.initialize();

    // Verify pipeline is loaded
    if (this.pipeline === null) {
      throw new Error(
        `Embedding model '${this.modelPath}' not loaded. ` +
        `Pipeline initialization may have failed silently.`
      );
    }

    try {
      // Type assertion since we know the pipeline is a function after initialization
      const output = await (this.pipeline as (input: string, options: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array | number[] }>)(
        trimmedText,
        { pooling: "mean", normalize: true }
      );

      // Validate output exists
      if (!output || output.data === undefined || output.data === null) {
        throw new Error(
          `Pipeline returned invalid output for text: "${trimmedText.slice(0, 50)}...". ` +
          `Output: ${JSON.stringify(output)}`
        );
      }

      // Convert Float32Array or nested array to flat number array
      const result = Array.from(output.data);

      // Validate dimensions match expected
      if (result.length !== this.dimensions) {
        throw new Error(
          `Embedding dimension mismatch: expected ${this.dimensions}, got ${result.length}. ` +
          `Model '${this.modelPath}' may not be loaded correctly. ` +
          `Input text: "${trimmedText.slice(0, 50)}..."`
        );
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Embedding generation failed: ${message}`);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    // Validate and clean inputs
    const cleanedTexts = texts.map((text, index) => {
      if (!text || typeof text !== "string") {
        throw new Error(`Embedding input at index ${index} must be a non-empty string`);
      }
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        throw new Error(`Embedding input at index ${index} cannot be empty or whitespace-only`);
      }
      return trimmed;
    });

    await this.initialize();

    // Verify pipeline is loaded
    if (this.pipeline === null) {
      throw new Error(
        `Embedding model '${this.modelPath}' not loaded. ` +
        `Pipeline initialization may have failed silently.`
      );
    }

    try {
      // Process texts in batch for better efficiency
      const output = await (this.pipeline as (inputs: string[], options: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array | number[]; dims: number[] }>)(
        cleanedTexts,
        { pooling: "mean", normalize: true }
      );

      // Validate output exists
      if (!output || output.data === undefined || output.data === null) {
        throw new Error(
          `Pipeline returned invalid output for batch of ${cleanedTexts.length} texts. ` +
          `Output: ${JSON.stringify(output)}`
        );
      }

      // Output has shape [batch_size, dimensions]
      const batchSize = cleanedTexts.length;
      const dims = this.dimensions;
      const expectedLength = batchSize * dims;

      // Validate total output size
      if (output.data.length !== expectedLength) {
        throw new Error(
          `Batch embedding size mismatch: expected ${expectedLength} values ` +
          `(${batchSize} texts × ${dims} dimensions), got ${output.data.length}. ` +
          `Model '${this.modelPath}' may not be loaded correctly.`
        );
      }

      const results: number[][] = [];

      for (let i = 0; i < batchSize; i++) {
        const start = i * dims;
        const end = start + dims;
        const embedding = Array.from(output.data.slice(start, end));

        // Validate each embedding
        if (embedding.length !== dims) {
          throw new Error(
            `Embedding at index ${i} has wrong dimensions: expected ${dims}, got ${embedding.length}`
          );
        }

        results.push(embedding);
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
