/**
 * Embedding provider abstraction for vector generation.
 * Supports both local (transformers.js/ONNX) and cloud (OpenAI, Gemini) providers.
 */

/**
 * Interface for embedding providers that generate vector representations of text.
 * Implementations include local models (transformers.js) and cloud APIs (OpenAI).
 */
export interface EmbeddingProvider {
  /**
   * Generate an embedding vector for a single text input.
   * @param text - The text to embed
   * @returns A promise resolving to the embedding vector (array of numbers)
   */
  embed(text: string): Promise<number[]>;

  /**
   * Generate embedding vectors for multiple texts in a single batch.
   * More efficient than calling embed() multiple times for large inputs.
   * @param texts - Array of texts to embed
   * @returns A promise resolving to an array of embedding vectors
   */
  embedBatch(texts: string[]): Promise<number[][]>;

  /**
   * Get the dimensionality of the embedding vectors produced by this provider.
   * @returns The number of dimensions in the embedding vectors
   */
  getDimensions(): number;

  /**
   * Get the name/identifier of the model used for embeddings.
   * @returns The model name (e.g., 'text-embedding-3-small', 'all-MiniLM-L6-v2')
   */
  getModelName(): string;
}
