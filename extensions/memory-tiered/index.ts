/**
 * @openclaw/memory-tiered
 *
 * Tiered Local Memory System with Reversible Forgetting
 * A 4-tier memory system (HOT/WARM/COLD/ARCHIVE) with composite scoring,
 * reversible soft-delete, and fully offline operation using SQLite + FTS5 + sqlite-vec
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "./db/sqlite.js";
import { FTS5Helper } from "./db/fts.js";
import { VectorHelper } from "./db/vectors.js";

import { LocalEmbeddingProvider } from "./embeddings/local.js";
import { OpenAIEmbeddingProvider } from "./embeddings/openai.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";

import {
  configSchema,
  resolveConfig,
  type MemoryTieredConfig,
  type ResolvedConfig,
} from "./config.js";

import { MemoryStoreTool } from "./tools/memory_store.js";
import { MemoryRecallTool } from "./tools/memory_recall.js";
import { MemoryForgetTool } from "./tools/memory_forget.js";
import { MemoryRestoreTool } from "./tools/memory_restore.js";
import { MemoryPinTool } from "./tools/memory_pin.js";
import { MemoryUnpinTool } from "./tools/memory_unpin.js";
import { MemoryExplainTool } from "./tools/memory_explain.js";
import { MemorySetContextTool } from "./tools/memory_set_context.js";
import { MemoryClearContextTool } from "./tools/memory_clear_context.js";

import { createAutoRecallHook } from "./hooks/auto_recall.js";
import { createAutoCaptureHook } from "./hooks/auto_capture.js";

/**
 * Plugin API interface matching OpenClaw plugin registration requirements.
 * This is a minimal interface for the expected API shape.
 */
export interface PluginApi {
  registerTool(name: string, tool: ToolDefinition): void;
  on(event: string, handler: (...args: unknown[]) => unknown): void;
}

/**
 * Tool definition for OpenClaw registration.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (input: unknown) => Promise<unknown>;
}

/**
 * Plugin definition matching OpenClaw plugin structure.
 */
export interface Plugin {
  id: string;
  name: string;
  kind: string;
  configSchema: typeof configSchema;
  register: (api: PluginApi, config: unknown) => Promise<void>;
}

/**
 * Create the embedding provider based on configuration.
 * @param config - Resolved configuration
 * @returns The configured embedding provider
 */
function createEmbeddingProvider(config: ResolvedConfig): EmbeddingProvider {
  const provider = config.embedding.provider;

  if (provider === "openai") {
    if (!config.embedding.apiKey) {
      throw new Error(
        "OpenAI embedding provider requires an API key. " +
        "Set 'embedding.apiKey' in your config or use the OPENAI_API_KEY environment variable."
      );
    }
    return new OpenAIEmbeddingProvider({
      apiKey: config.embedding.apiKey,
      model: config.embedding.model,
    });
  }

  if (provider === "local") {
    return new LocalEmbeddingProvider({
      modelPath: config.embedding.local.modelPath,
    });
  }

  // Auto mode: try local first, fall back to OpenAI if API key available
  if (provider === "auto") {
    // Check if OpenAI API key is available
    const apiKey = config.embedding.apiKey ?? process.env.OPENAI_API_KEY;

    // Prefer local for offline operation
    try {
      return new LocalEmbeddingProvider({
        modelPath: config.embedding.local.modelPath,
      });
    } catch {
      // If local fails and we have an API key, try OpenAI
      if (apiKey) {
        return new OpenAIEmbeddingProvider({
          apiKey,
          model: config.embedding.model,
        });
      }
      throw new Error(
        "Failed to initialize local embedding provider and no OpenAI API key available. " +
        "Install @xenova/transformers for local embeddings or provide an API key."
      );
    }
  }

  // Gemini provider not implemented yet
  if (provider === "gemini") {
    throw new Error(
      "Gemini embedding provider is not yet implemented. " +
      "Use 'local' or 'openai' instead."
    );
  }

  throw new Error(`Unknown embedding provider: ${provider}`);
}

/**
 * Plugin definition for the tiered memory system.
 */
const plugin: Plugin = {
  id: "memory-tiered",
  name: "Memory (Tiered)",
  kind: "memory",
  configSchema,

  async register(api: PluginApi, rawConfig: unknown): Promise<void> {
    // Parse and resolve configuration
    const parsedConfig = configSchema.parse(rawConfig) as MemoryTieredConfig;
    const config = resolveConfig(parsedConfig);

    // Ensure database directory exists
    const dbDir = dirname(config.dbPath);
    try {
      mkdirSync(dbDir, { recursive: true });
    } catch {
      // Directory may already exist, ignore errors
    }

    // Initialize database
    const database = new Database(config.dbPath);
    const db = database.getDb();

    // Initialize FTS5 helper
    const ftsHelper = new FTS5Helper(db);

    // Create embedding provider
    const embeddingProvider = createEmbeddingProvider(config);
    const dimensions = embeddingProvider.getDimensions();

    // Initialize vector helper with shared FTS helper
    const vectorHelper = new VectorHelper(db, dimensions, ftsHelper);

    // Create tool instances
    const storeTool = new MemoryStoreTool(db, embeddingProvider, vectorHelper);
    const recallTool = new MemoryRecallTool(db, embeddingProvider, vectorHelper);
    const forgetTool = new MemoryForgetTool(db, embeddingProvider, vectorHelper);
    const restoreTool = new MemoryRestoreTool(db);
    const pinTool = new MemoryPinTool(db);
    const unpinTool = new MemoryUnpinTool(db);
    const explainTool = new MemoryExplainTool(db, embeddingProvider, vectorHelper);
    const setContextTool = new MemorySetContextTool(db);
    const clearContextTool = new MemoryClearContextTool(db);

    // Register all 9 tools
    api.registerTool("memory_store", {
      name: "memory_store",
      description: "Store a new memory in the tiered memory system with automatic deduplication.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The memory content text (required)",
          },
          tier: {
            type: "string",
            enum: ["HOT", "WARM"],
            description: "Initial tier placement (default: HOT)",
          },
          memory_type: {
            type: "string",
            enum: ["procedural", "factual", "project", "episodic"],
            description: "Type of memory affecting decay rate",
          },
          importance: {
            type: "number",
            description: "Importance score (0.0 to 1.0, default: 0.5)",
          },
          pinned: {
            type: "boolean",
            description: "Whether to pin this memory (default: false)",
          },
          category: {
            type: "string",
            description: "Category for grouping memories",
          },
          source: {
            type: "string",
            description: "Origin of the memory",
          },
        },
        required: ["text"],
      },
      execute: async (input) => storeTool.execute(input as Parameters<typeof storeTool.execute>[0]),
    });

    api.registerTool("memory_recall", {
      name: "memory_recall",
      description: "Search and retrieve relevant memories using hybrid text and semantic search.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query text (required)",
          },
          limit: {
            type: "number",
            description: "Maximum number of results (default: 5)",
          },
          tier: {
            type: "string",
            enum: ["HOT", "WARM", "COLD", "ARCHIVE"],
            description: "Filter by tier",
          },
          includeArchive: {
            type: "boolean",
            description: "Include ARCHIVE tier memories (default: false)",
          },
          includeForgotten: {
            type: "boolean",
            description: "Include forgotten (do_not_inject) memories (default: false)",
          },
        },
        required: ["query"],
      },
      execute: async (input) => recallTool.execute(input as Parameters<typeof recallTool.execute>[0]),
    });

    api.registerTool("memory_forget", {
      name: "memory_forget",
      description: "Forget a memory (soft forget by default, reversible). Use hard=true for permanent deletion.",
      parameters: {
        type: "object",
        properties: {
          memoryId: {
            type: "string",
            description: "Specific memory ID to forget",
          },
          query: {
            type: "string",
            description: "Search query to find memory to forget",
          },
          hard: {
            type: "boolean",
            description: "If true, permanently delete instead of soft forget (default: false)",
          },
        },
      },
      execute: async (input) => forgetTool.execute(input as Parameters<typeof forgetTool.execute>[0]),
    });

    api.registerTool("memory_restore", {
      name: "memory_restore",
      description: "Restore a forgotten memory, re-enabling it for context injection.",
      parameters: {
        type: "object",
        properties: {
          memoryId: {
            type: "string",
            description: "Memory ID to restore (required)",
          },
        },
        required: ["memoryId"],
      },
      execute: async (input) => restoreTool.execute(input as Parameters<typeof restoreTool.execute>[0]),
    });

    api.registerTool("memory_pin", {
      name: "memory_pin",
      description: "Pin a memory to bypass decay and prioritize for injection.",
      parameters: {
        type: "object",
        properties: {
          memoryId: {
            type: "string",
            description: "Memory ID to pin (required)",
          },
        },
        required: ["memoryId"],
      },
      execute: async (input) => pinTool.execute(input as Parameters<typeof pinTool.execute>[0]),
    });

    api.registerTool("memory_unpin", {
      name: "memory_unpin",
      description: "Unpin a memory so it follows normal decay rules.",
      parameters: {
        type: "object",
        properties: {
          memoryId: {
            type: "string",
            description: "Memory ID to unpin (required)",
          },
        },
        required: ["memoryId"],
      },
      execute: async (input) => unpinTool.execute(input as Parameters<typeof unpinTool.execute>[0]),
    });

    api.registerTool("memory_explain", {
      name: "memory_explain",
      description: "Explain how a memory is scored and whether it's eligible for context injection.",
      parameters: {
        type: "object",
        properties: {
          memoryId: {
            type: "string",
            description: "Memory ID to explain (required)",
          },
          query: {
            type: "string",
            description: "Optional query for similarity calculation",
          },
        },
        required: ["memoryId"],
      },
      execute: async (input) => explainTool.execute(input as Parameters<typeof explainTool.execute>[0]),
    });

    api.registerTool("memory_set_context", {
      name: "memory_set_context",
      description: "Set the current active task context for automatic recall.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The context text (required)",
          },
          ttlHours: {
            type: "number",
            description: "Time-to-live in hours (default: 4)",
          },
        },
        required: ["text"],
      },
      execute: async (input) => setContextTool.execute(input as Parameters<typeof setContextTool.execute>[0]),
    });

    api.registerTool("memory_clear_context", {
      name: "memory_clear_context",
      description: "Clear the current active task context.",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async () => clearContextTool.execute(),
    });

    // Create hook instances
    const autoRecallHook = createAutoRecallHook(db, embeddingProvider, vectorHelper, config);
    const autoCaptureHook = createAutoCaptureHook(db, embeddingProvider, vectorHelper, config);

    // Register hooks
    api.on("before_agent_start", async (prompt: unknown) => {
      if (typeof prompt !== "string") {
        return {};
      }
      return autoRecallHook.execute(prompt);
    });

    api.on("agent_end", async (response: unknown) => {
      if (typeof response !== "string") {
        return {};
      }
      return autoCaptureHook.execute(response);
    });
  },
};

export default plugin;
