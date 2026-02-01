/**
 * OpenAI embedding provider for cloud-based vector generation.
 * Default model: text-embedding-3-small (1536 dimensions)
 */

import type { EmbeddingProvider } from "./provider.js";

// Default model for OpenAI embeddings
const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DIMENSIONS = 1536;

// Model dimension mapping for OpenAI embedding models
const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

// OpenAI API endpoint for embeddings
const OPENAI_API_URL = "https://api.openai.com/v1/embeddings";

/**
 * Configuration options for the OpenAI embedding provider.
 */
export interface OpenAIEmbeddingConfig {
  /**
   * OpenAI API key. Required for authentication.
   */
  apiKey: string;

  /**
   * OpenAI model to use for embeddings.
   * Defaults to text-embedding-3-small if not specified.
   */
  model?: string;
}

/**
 * Response format from OpenAI embeddings API.
 */
interface OpenAIEmbeddingResponse {
  object: string;
  data: Array<{
    object: string;
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/**
 * Error response format from OpenAI API.
 */
interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}

/**
 * OpenAI embedding provider for cloud-based embeddings.
 * Requires a valid API key for authentication.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dimensions: number;

  constructor(config: OpenAIEmbeddingConfig) {
    if (!config.apiKey) {
      throw new Error(
        "OpenAI API key is required. " +
        "Set 'embedding.apiKey' in your config or use the OPENAI_API_KEY environment variable."
      );
    }

    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.dimensions = MODEL_DIMENSIONS[this.model] ?? DEFAULT_DIMENSIONS;
  }

  /**
   * Make a request to the OpenAI embeddings API.
   */
  private async request(input: string | string[]): Promise<OpenAIEmbeddingResponse> {
    try {
      const response = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input,
        }),
      });

      const data = await response.json() as OpenAIEmbeddingResponse | OpenAIErrorResponse;

      if (!response.ok) {
        const errorData = data as OpenAIErrorResponse;
        const errorMessage = errorData.error?.message ?? `HTTP ${response.status}: ${response.statusText}`;

        // Provide specific guidance based on error type
        if (response.status === 401) {
          throw new Error(
            `OpenAI API authentication failed: ${errorMessage}. ` +
            "Check that your API key is valid and has not expired."
          );
        } else if (response.status === 429) {
          throw new Error(
            `OpenAI API rate limit exceeded: ${errorMessage}. ` +
            "Wait a moment and try again, or check your usage limits at https://platform.openai.com/usage"
          );
        } else if (response.status === 400) {
          throw new Error(
            `OpenAI API request error: ${errorMessage}. ` +
            "Check that your input text is valid and not too long."
          );
        } else {
          throw new Error(`OpenAI API error: ${errorMessage}`);
        }
      }

      return data as OpenAIEmbeddingResponse;
    } catch (error) {
      // Handle network errors
      if (error instanceof TypeError && error.message.includes("fetch")) {
        throw new Error(
          "Failed to connect to OpenAI API. Check your internet connection and try again."
        );
      }
      throw error;
    }
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.request(text);

    if (!response.data || response.data.length === 0) {
      throw new Error("OpenAI API returned empty embedding data");
    }

    return response.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await this.request(texts);

    if (!response.data || response.data.length !== texts.length) {
      throw new Error(
        `OpenAI API returned ${response.data?.length ?? 0} embeddings, expected ${texts.length}`
      );
    }

    // Sort by index to ensure correct order (OpenAI may return out of order)
    const sorted = response.data.slice().sort((a, b) => a.index - b.index);
    return sorted.map((item) => item.embedding);
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModelName(): string {
    return this.model;
  }
}
