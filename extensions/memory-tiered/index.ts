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

import {
  EmbeddingProviderUnavailableError,
  NoEmbeddingProviderError,
} from "./core/errors.js";

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

import { DecayEngine } from "./core/decay.js";
import { PromotionEngine } from "./core/promotion.js";

// CLI command imports
import { MemorySearchCommand } from "./cli/search.js";
import { MemoryListCommand } from "./cli/list.js";
import { MemoryStatsCommand } from "./cli/stats.js";
import { MemoryForgetCommand } from "./cli/forget.js";
import { MemoryRestoreCommand } from "./cli/restore.js";
import { MemoryPinCommand } from "./cli/pin.js";
import { MemoryUnpinCommand } from "./cli/unpin.js";
import { MemoryExplainCommand } from "./cli/explain.js";
import { MemorySetContextCommand, MemoryClearContextCommand } from "./cli/context.js";
import { MemoryDecayCommand } from "./cli/decay.js";
import { MemoryIndexCommand } from "./cli/index.js";
import { MemoryMigrateCommand } from "./cli/migrate.js";

/**
 * CLI command definition for OpenClaw registration.
 */
export interface CliCommandDefinition {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
  }>;
  options?: Array<{
    flags: string;
    description: string;
    default?: unknown;
  }>;
  execute: (args: Record<string, unknown>, options: Record<string, unknown>) => Promise<string>;
}

/**
 * CLI registration options.
 */
export interface CliRegistrationOptions {
  commands: string[];
}

/**
 * Service definition for OpenClaw registration.
 */
export interface ServiceDefinition {
  id: string;
  description: string;
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
}

/**
 * Plugin API interface matching OpenClaw plugin registration requirements.
 * This is a minimal interface for the expected API shape.
 */
export interface PluginApi {
  registerTool(name: string, tool: ToolDefinition): void;
  registerCli(
    parentCommand: string,
    description: string,
    subcommands: CliCommandDefinition[],
    options?: CliRegistrationOptions
  ): void;
  registerService(service: ServiceDefinition): void;
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
 * Provides detailed error handling with actionable guidance.
 *
 * @param config - Resolved configuration
 * @returns The configured embedding provider
 * @throws EmbeddingProviderUnavailableError - When a specific provider fails
 * @throws NoEmbeddingProviderError - When no provider could be initialized
 */
function createEmbeddingProvider(config: ResolvedConfig): EmbeddingProvider {
  const provider = config.embedding.provider;
  const providerErrors: Record<string, string> = {};
  const triedProviders: string[] = [];

  if (provider === "openai") {
    triedProviders.push("openai");
    if (!config.embedding.apiKey) {
      throw new EmbeddingProviderUnavailableError(
        "openai",
        "API key not provided"
      );
    }
    try {
      return new OpenAIEmbeddingProvider({
        apiKey: config.embedding.apiKey,
        model: config.embedding.model,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new EmbeddingProviderUnavailableError("openai", message);
    }
  }

  if (provider === "local") {
    triedProviders.push("local");
    try {
      return new LocalEmbeddingProvider({
        modelPath: config.embedding.local.modelPath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new EmbeddingProviderUnavailableError("local", message);
    }
  }

  // Auto mode: try local first, fall back to OpenAI if API key available
  if (provider === "auto") {
    // Check if OpenAI API key is available
    const apiKey = config.embedding.apiKey ?? process.env.OPENAI_API_KEY;

    // Prefer local for offline operation
    triedProviders.push("local");
    try {
      return new LocalEmbeddingProvider({
        modelPath: config.embedding.local.modelPath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      providerErrors["local"] = message;
    }

    // If local fails and we have an API key, try OpenAI
    if (apiKey) {
      triedProviders.push("openai");
      try {
        return new OpenAIEmbeddingProvider({
          apiKey,
          model: config.embedding.model,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        providerErrors["openai"] = message;
      }
    } else {
      providerErrors["openai"] = "No API key provided";
    }

    // All providers failed
    throw new NoEmbeddingProviderError(triedProviders, providerErrors);
  }

  // Gemini provider not implemented yet
  if (provider === "gemini") {
    throw new EmbeddingProviderUnavailableError(
      "gemini",
      "Gemini embedding provider is not yet implemented. Use 'local' or 'openai' instead."
    );
  }

  throw new EmbeddingProviderUnavailableError(
    provider,
    `Unknown embedding provider type: ${provider}. Valid options are: local, openai, gemini, auto`
  );
}

/**
 * DecayService - Background service for automatic memory tier decay and promotion.
 *
 * This service runs the DecayEngine and PromotionEngine on a configurable interval
 * to automatically demote stale memories and promote frequently-used ones.
 */
class DecayService {
  private db: ReturnType<Database["getDb"]>;
  private config: ResolvedConfig;
  private decayEngine: DecayEngine;
  private promotionEngine: PromotionEngine;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private intervalHours: number;

  /**
   * Create a new DecayService instance.
   * @param db - The better-sqlite3 database instance
   * @param config - Resolved plugin configuration
   */
  constructor(db: ReturnType<Database["getDb"]>, config: ResolvedConfig) {
    this.db = db;
    this.config = config;
    this.decayEngine = new DecayEngine(db, config);
    this.promotionEngine = new PromotionEngine(db, config);
    this.intervalHours = config.decay.intervalHours;
  }

  /**
   * Start the background decay service.
   * Schedules periodic runs based on config.decay.intervalHours.
   * Checks last_decay_run to avoid duplicate runs.
   */
  start(): void {
    // Run immediately if enough time has passed since last run
    if (this.decayEngine.shouldRun(this.intervalHours)) {
      this.runCycle();
    }

    // Schedule periodic runs
    const intervalMs = this.intervalHours * 60 * 60 * 1000;
    this.intervalId = setInterval(() => {
      this.runCycle();
    }, intervalMs);
  }

  /**
   * Stop the background decay service.
   * Clears the scheduled interval.
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Run one cycle of decay and promotion.
   * Called on each interval tick.
   */
  private runCycle(): void {
    // Run decay engine first (demote stale memories)
    this.decayEngine.run();
    // Then run promotion engine (promote frequently-used memories)
    this.promotionEngine.run();
  }
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

    // Create CLI command instances
    const searchCommand = new MemorySearchCommand(db, embeddingProvider, vectorHelper);
    const listCommand = new MemoryListCommand(db);
    const statsCommand = new MemoryStatsCommand(db, config.dbPath, embeddingProvider, config);
    const forgetCommand = new MemoryForgetCommand(db, embeddingProvider, vectorHelper);
    const restoreCommand = new MemoryRestoreCommand(db);
    const pinCommand = new MemoryPinCommand(db);
    const unpinCommand = new MemoryUnpinCommand(db);
    const explainCommand = new MemoryExplainCommand(db, embeddingProvider, vectorHelper);
    const setContextCommand = new MemorySetContextCommand(db);
    const clearContextCommand = new MemoryClearContextCommand(db);
    const decayCommand = new MemoryDecayCommand(db, config);
    const indexCommand = new MemoryIndexCommand(db, embeddingProvider, vectorHelper);
    const migrateCommand = new MemoryMigrateCommand(db, embeddingProvider, vectorHelper);

    // Register CLI commands under 'memory' parent command
    api.registerCli(
      "memory",
      "Manage tiered memory system - search, list, and organize memories",
      [
        {
          name: "search",
          description: "Search memories using hybrid text and semantic search",
          arguments: [
            {
              name: "query",
              description: "Search query text",
              required: true,
            },
          ],
          options: [
            {
              flags: "--deep",
              description: "Include ARCHIVE tier memories",
            },
            {
              flags: "--tier <tier>",
              description: "Filter by tier (HOT, WARM, COLD, ARCHIVE)",
            },
            {
              flags: "--limit <n>",
              description: "Maximum number of results",
              default: 10,
            },
            {
              flags: "--json",
              description: "Output as JSON",
            },
            {
              flags: "--explain",
              description: "Show scoring breakdown for each result",
            },
          ],
          execute: async (args, options) => {
            return searchCommand.execute(args.query as string, {
              deep: options.deep as boolean | undefined,
              tier: options.tier as "HOT" | "WARM" | "COLD" | "ARCHIVE" | undefined,
              limit: options.limit as number | undefined,
              json: options.json as boolean | undefined,
              explain: options.explain as boolean | undefined,
            });
          },
        },
        {
          name: "list",
          description: "List memories by tier with optional filters",
          options: [
            {
              flags: "--tier <tier>",
              description: "Filter by tier (HOT, WARM, COLD, ARCHIVE)",
            },
            {
              flags: "--forgotten",
              description: "Show only forgotten memories",
            },
            {
              flags: "--pinned",
              description: "Show only pinned memories",
            },
            {
              flags: "--sort <field>",
              description: "Sort by field (created_at, last_accessed_at, use_count)",
            },
            {
              flags: "--limit <n>",
              description: "Maximum number of results",
              default: 20,
            },
            {
              flags: "--json",
              description: "Output as JSON",
            },
          ],
          execute: async (_args, options) => {
            return listCommand.execute({
              tier: options.tier as "HOT" | "WARM" | "COLD" | "ARCHIVE" | undefined,
              forgotten: options.forgotten as boolean | undefined,
              pinned: options.pinned as boolean | undefined,
              sort: options.sort as "created_at" | "last_accessed_at" | "use_count" | undefined,
              limit: options.limit as number | undefined,
              json: options.json as boolean | undefined,
            });
          },
        },
        {
          name: "stats",
          description: "Display memory statistics and system information",
          options: [
            {
              flags: "--json",
              description: "Output as JSON",
            },
          ],
          execute: async (_args, options) => {
            return statsCommand.execute({
              json: options.json as boolean | undefined,
            });
          },
        },
        {
          name: "forget",
          description: "Forget a memory (soft forget by default, reversible)",
          arguments: [
            {
              name: "idOrQuery",
              description: "Memory ID or search query to find memory",
              required: true,
            },
          ],
          options: [
            {
              flags: "--hard",
              description: "Permanently delete instead of soft forget",
            },
            {
              flags: "--confirm",
              description: "Confirm hard deletion (required with --hard)",
            },
            {
              flags: "--json",
              description: "Output as JSON",
            },
          ],
          execute: async (args, options) => {
            return forgetCommand.execute(args.idOrQuery as string, {
              hard: options.hard as boolean | undefined,
              confirm: options.confirm as boolean | undefined,
              json: options.json as boolean | undefined,
            });
          },
        },
        {
          name: "restore",
          description: "Restore a forgotten memory",
          arguments: [
            {
              name: "id",
              description: "Memory ID to restore",
              required: true,
            },
          ],
          options: [
            {
              flags: "--json",
              description: "Output as JSON",
            },
          ],
          execute: async (args, options) => {
            return restoreCommand.execute(args.id as string, {
              json: options.json as boolean | undefined,
            });
          },
        },
        {
          name: "pin",
          description: "Pin a memory to bypass decay and prioritize for injection",
          arguments: [
            {
              name: "id",
              description: "Memory ID to pin",
              required: true,
            },
          ],
          options: [
            {
              flags: "--json",
              description: "Output as JSON",
            },
          ],
          execute: async (args, options) => {
            return pinCommand.execute(args.id as string, {
              json: options.json as boolean | undefined,
            });
          },
        },
        {
          name: "unpin",
          description: "Unpin a memory so it follows normal decay rules",
          arguments: [
            {
              name: "id",
              description: "Memory ID to unpin",
              required: true,
            },
          ],
          options: [
            {
              flags: "--json",
              description: "Output as JSON",
            },
          ],
          execute: async (args, options) => {
            return unpinCommand.execute(args.id as string, {
              json: options.json as boolean | undefined,
            });
          },
        },
        {
          name: "explain",
          description: "Explain how a memory is scored and its injection eligibility",
          arguments: [
            {
              name: "id",
              description: "Memory ID to explain",
              required: true,
            },
          ],
          options: [
            {
              flags: "--query <query>",
              description: "Query for similarity calculation",
            },
            {
              flags: "--json",
              description: "Output as JSON",
            },
          ],
          execute: async (args, options) => {
            return explainCommand.execute(args.id as string, {
              query: options.query as string | undefined,
              json: options.json as boolean | undefined,
            });
          },
        },
        {
          name: "set-context",
          description: "Set the current active task context for automatic recall",
          arguments: [
            {
              name: "text",
              description: "Context text to set",
              required: true,
            },
          ],
          options: [
            {
              flags: "--ttl <hours>",
              description: "Time-to-live in hours",
              default: 4,
            },
            {
              flags: "--json",
              description: "Output as JSON",
            },
          ],
          execute: async (args, options) => {
            return setContextCommand.execute(args.text as string, {
              ttl: options.ttl as number | undefined,
              json: options.json as boolean | undefined,
            });
          },
        },
        {
          name: "clear-context",
          description: "Clear the current active task context",
          options: [
            {
              flags: "--json",
              description: "Output as JSON",
            },
          ],
          execute: async (_args, options) => {
            return clearContextCommand.execute({
              json: options.json as boolean | undefined,
            });
          },
        },
        {
          name: "decay",
          description: "Manually trigger decay and promotion cycle",
          arguments: [
            {
              name: "action",
              description: "Action to perform (run)",
              required: true,
            },
          ],
          options: [
            {
              flags: "--json",
              description: "Output as JSON",
            },
          ],
          execute: async (args, options) => {
            const action = args.action as string;
            if (action !== "run") {
              return `Unknown decay action: ${action}. Use 'run' to trigger decay.`;
            }
            return decayCommand.execute({
              json: options.json as boolean | undefined,
            });
          },
        },
        {
          name: "index",
          description: "Index legacy memory files (MEMORY.md, memory/*.md) into the tiered system",
          options: [
            {
              flags: "--force",
              description: "Re-index all files (ignore hash check)",
            },
            {
              flags: "--json",
              description: "Output as JSON",
            },
          ],
          execute: async (_args, options) => {
            return indexCommand.execute({
              force: options.force as boolean | undefined,
              json: options.json as boolean | undefined,
            });
          },
        },
        {
          name: "migrate",
          description: "Migrate memory data from external sources (e.g., LanceDB)",
          options: [
            {
              flags: "--from <source>",
              description: "Source to migrate from (currently only 'lancedb' supported)",
              default: "lancedb",
            },
            {
              flags: "--preview",
              description: "Show migration plan without executing",
            },
            {
              flags: "--rollback",
              description: "Rollback to previous backup (restores original LanceDB)",
            },
            {
              flags: "--json",
              description: "Output as JSON",
            },
          ],
          execute: async (_args, options) => {
            return migrateCommand.execute({
              from: options.from as string | undefined,
              preview: options.preview as boolean | undefined,
              rollback: options.rollback as boolean | undefined,
              json: options.json as boolean | undefined,
            });
          },
        },
      ],
      { commands: ["memory"] }
    );

    // Create and register the decay service
    const decayService = new DecayService(db, config);
    api.registerService({
      id: "memory-tiered-decay",
      description: "Background service for automatic memory tier decay and promotion",
      start: () => decayService.start(),
      stop: () => decayService.stop(),
    });
  },
};

export default plugin;
