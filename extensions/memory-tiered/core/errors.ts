/**
 * Custom error classes for the tiered memory system.
 * All errors include actionable guidance for users and developers.
 */

/**
 * Base error class for memory-tiered plugin errors.
 * Includes error code and actionable guidance.
 */
export class MemoryError extends Error {
  /** Error code for programmatic handling */
  readonly code: string;
  /** Actionable guidance for the user */
  readonly guidance: string;
  /** Whether the error is retryable */
  readonly retryable: boolean;

  constructor(
    message: string,
    code: string,
    guidance: string,
    retryable = false
  ) {
    super(`${message}. ${guidance}`);
    this.name = "MemoryError";
    this.code = code;
    this.guidance = guidance;
    this.retryable = retryable;
  }
}

/**
 * Error thrown when a memory is not found by ID.
 */
export class MemoryNotFoundError extends MemoryError {
  /** The memory ID that was not found */
  readonly memoryId: string;

  constructor(memoryId: string) {
    super(
      `Memory not found: ${memoryId}`,
      "MEMORY_NOT_FOUND",
      "Verify the memory ID is correct. Use 'memory search' to find memories by content."
    );
    this.name = "MemoryNotFoundError";
    this.memoryId = memoryId;
  }
}

/**
 * Error thrown when a memory ID has an invalid format.
 */
export class InvalidMemoryIdError extends MemoryError {
  /** The invalid memory ID */
  readonly memoryId: string;

  constructor(memoryId: string) {
    super(
      `Invalid memory ID format: ${memoryId}`,
      "INVALID_MEMORY_ID",
      "Memory IDs must be valid UUIDs (e.g., 550e8400-e29b-41d4-a716-446655440000). Use 'memory search' to find memories."
    );
    this.name = "InvalidMemoryIdError";
    this.memoryId = memoryId;
  }
}

/**
 * Error thrown when a similar memory already exists (for duplicate detection).
 */
export class SimilarMemoryExistsError extends MemoryError {
  /** The ID of the existing similar memory */
  readonly existingId: string;
  /** The similarity score (0-1) */
  readonly similarity: number;

  constructor(existingId: string, similarity: number) {
    super(
      `Similar memory exists: ${existingId}`,
      "SIMILAR_MEMORY_EXISTS",
      `A memory with ${(similarity * 100).toFixed(1)}% similarity already exists. Use memory_recall to view it.`
    );
    this.name = "SimilarMemoryExistsError";
    this.existingId = existingId;
    this.similarity = similarity;
  }
}

/**
 * Error thrown when trying to forget an already forgotten memory.
 */
export class AlreadyForgottenError extends MemoryError {
  /** The memory ID that is already forgotten */
  readonly memoryId: string;

  constructor(memoryId: string) {
    super(
      `Memory is already forgotten: ${memoryId}`,
      "ALREADY_FORGOTTEN",
      "Use hard=true for permanent deletion, or memory_restore to restore it first."
    );
    this.name = "AlreadyForgottenError";
    this.memoryId = memoryId;
  }
}

/**
 * Error thrown when trying to restore a memory that is not forgotten.
 */
export class NotForgottenError extends MemoryError {
  /** The memory ID that is not forgotten */
  readonly memoryId: string;

  constructor(memoryId: string) {
    super(
      `Memory is not forgotten: ${memoryId}`,
      "NOT_FORGOTTEN",
      "Only soft-forgotten memories can be restored. This memory is already active in the system."
    );
    this.name = "NotForgottenError";
    this.memoryId = memoryId;
  }
}

/**
 * Error thrown when a memory is already pinned.
 */
export class AlreadyPinnedError extends MemoryError {
  /** The memory ID that is already pinned */
  readonly memoryId: string;

  constructor(memoryId: string) {
    super(
      `Memory is already pinned: ${memoryId}`,
      "ALREADY_PINNED",
      "Pinned memories are exempt from decay and have priority in context injection."
    );
    this.name = "AlreadyPinnedError";
    this.memoryId = memoryId;
  }
}

/**
 * Error thrown when a memory is not pinned (when trying to unpin).
 */
export class NotPinnedError extends MemoryError {
  /** The memory ID that is not pinned */
  readonly memoryId: string;

  constructor(memoryId: string) {
    super(
      `Memory is not pinned: ${memoryId}`,
      "NOT_PINNED",
      "Only pinned memories can be unpinned. Use 'memory pin' to pin a memory first."
    );
    this.name = "NotPinnedError";
    this.memoryId = memoryId;
  }
}

/**
 * Error thrown when the database is locked (busy).
 */
export class DatabaseLockedError extends MemoryError {
  /** Number of retry attempts made */
  readonly attempts: number;

  constructor(attempts: number, originalError?: string) {
    super(
      `Database locked after ${attempts} attempts${originalError ? `: ${originalError}` : ""}`,
      "DATABASE_LOCKED",
      "The database is busy with other operations. Try again in a moment. If this persists, check for hung processes accessing the database.",
      true // retryable
    );
    this.name = "DatabaseLockedError";
    this.attempts = attempts;
  }
}

/**
 * Error thrown when the embedding provider is unavailable.
 */
export class EmbeddingProviderUnavailableError extends MemoryError {
  /** The provider type that is unavailable */
  readonly provider: string;
  /** The underlying error message */
  readonly cause?: string;

  constructor(provider: string, cause?: string) {
    const causeMessage = cause ? ` (${cause})` : "";
    let guidance: string;

    switch (provider) {
      case "local":
        guidance =
          "The local embedding model failed to load. Ensure @xenova/transformers is installed: npm install @xenova/transformers";
        break;
      case "openai":
        guidance =
          "OpenAI API is unavailable. Check your API key in config (embedding.apiKey) or set OPENAI_API_KEY environment variable.";
        break;
      case "gemini":
        guidance =
          "Gemini API is unavailable. Check your API key in config (embedding.apiKey) or set GEMINI_API_KEY environment variable.";
        break;
      default:
        guidance =
          "The embedding provider is unavailable. Check your configuration at embedding.provider and ensure required dependencies are installed.";
    }

    super(
      `Embedding provider unavailable: ${provider}${causeMessage}`,
      "EMBEDDING_PROVIDER_UNAVAILABLE",
      guidance,
      true // retryable for transient failures
    );
    this.name = "EmbeddingProviderUnavailableError";
    this.provider = provider;
    this.cause = cause;
  }
}

/**
 * Error thrown when no embedding provider could be initialized.
 */
export class NoEmbeddingProviderError extends MemoryError {
  /** List of providers that were tried */
  readonly triedProviders: string[];
  /** Errors from each provider attempt */
  readonly providerErrors: Record<string, string>;

  constructor(
    triedProviders: string[],
    providerErrors: Record<string, string>
  ) {
    const errorDetails = Object.entries(providerErrors)
      .map(([provider, error]) => `  - ${provider}: ${error}`)
      .join("\n");

    super(
      `No embedding provider available. Tried: ${triedProviders.join(", ")}`,
      "NO_EMBEDDING_PROVIDER",
      `Failed to initialize any embedding provider.\n${errorDetails}\n\nSuggestions:\n1. For offline use: npm install @xenova/transformers\n2. For OpenAI: Set embedding.apiKey or OPENAI_API_KEY\n3. Check embedding.provider in your config`
    );
    this.name = "NoEmbeddingProviderError";
    this.triedProviders = triedProviders;
    this.providerErrors = providerErrors;
  }
}

/**
 * Error thrown when query text is empty or invalid.
 */
export class EmptyQueryError extends MemoryError {
  constructor() {
    super(
      "Query text cannot be empty",
      "EMPTY_QUERY",
      "Provide a non-empty search query. Use at least a few meaningful words for best results."
    );
    this.name = "EmptyQueryError";
  }
}

/**
 * Error thrown when memory text is empty or invalid.
 */
export class EmptyMemoryTextError extends MemoryError {
  constructor() {
    super(
      "Memory text cannot be empty",
      "EMPTY_MEMORY_TEXT",
      "Provide non-empty text content for the memory."
    );
    this.name = "EmptyMemoryTextError";
  }
}

/**
 * UUID regex pattern for memory ID validation.
 */
export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that a string is a valid UUID format.
 * @param id - The string to validate
 * @returns true if valid UUID format
 */
export function isValidUUID(id: string): boolean {
  return UUID_REGEX.test(id);
}

/**
 * Validate a memory ID and throw InvalidMemoryIdError if invalid.
 * @param memoryId - The memory ID to validate
 * @throws InvalidMemoryIdError if the ID is not a valid UUID
 */
export function validateMemoryId(memoryId: string): void {
  if (!isValidUUID(memoryId)) {
    throw new InvalidMemoryIdError(memoryId);
  }
}
