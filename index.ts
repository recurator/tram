/**
 * @openclaw/tram
 *
 * TRAM - Tiered Reversible Associative Memory
 * A 4-tier memory system (HOT/WARM/COLD/ARCHIVE) with composite scoring,
 * reversible soft-delete, and fully offline operation using SQLite + FTS5 + sqlite-vec
 *
 * This plugin follows the OpenClaw plugin API documented at:
 * https://docs.openclaw.ai/plugin
 */

import { Type } from "@sinclair/typebox";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Note: Plugin hooks are registered via api.registerHook() in the register() function

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
import { MemoryTuneTool } from "./tools/memory_tune.js";

// File-based hook initializers
import { initAutoRecallHook } from "./hooks/auto-recall/handler.js";
import { initAutoCaptureHook } from "./hooks/auto-capture/handler.js";

import { DecayEngine } from "./core/decay.js";
import { PromotionEngine } from "./core/promotion.js";
import { TuningEngine } from "./core/tuning.js";
import { TuningReporter } from "./services/reporter.js";

// Hook handlers
import autoRecallHandler from "./hooks/auto-recall/handler.js";
import autoCaptureHandler, { getCurrentSessionType } from "./hooks/auto-capture/handler.js";

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
import { MemoryLockCommand } from "./cli/lock.js";

/**
 * Commander.js Command interface (provided by OpenClaw)
 * Uses 'any' for action callback to match Commander.js flexible typing
 */
interface Command {
  name(): string;
  command(name: string): Command;
  description(desc: string): Command;
  argument(name: string, description?: string): Command;
  option(flags: string, description?: string, defaultValue?: unknown): Command;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  action(fn: (...args: any[]) => void | Promise<void>): Command;
}

/**
 * CLI registration callback context
 */
interface CliRegistrationContext {
  program: Command;
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
  description?: string;
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
}

/**
 * Tool definition for OpenClaw registration.
 * See: https://docs.openclaw.ai/plugins/agent-tools
 */
export interface ToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: unknown; details?: unknown }>;
}

/**
 * OpenClaw Plugin API interface.
 * See: https://docs.openclaw.ai/plugin
 */
// Hook types are defined in the handler files - use 'any' for flexibility with OpenClaw's internal types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HookHandler = (event: any) => Promise<void> | void;

export interface OpenClawPluginApi {
  /** Plugin configuration from openclaw config file */
  pluginConfig: unknown;

  /** Register a tool for agent use */
  registerTool(tool: ToolDefinition, options?: { optional?: boolean }): void;

  /** Register CLI commands using Commander.js callback pattern */
  registerCli(
    register: (ctx: CliRegistrationContext) => void,
    options?: CliRegistrationOptions
  ): void;

  /** Register a background service */
  registerService(service: ServiceDefinition): void;

  /** Register a hook handler for events */
  registerHook?(
    events: string | string[],
    handler: HookHandler,
    opts?: { entry?: unknown; register?: boolean }
  ): void;

  /** Logger instance */
  logger?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    debug(message: string): void;
  };

  /** Resolve path with ~ expansion */
  resolvePath?(path: string): string;
}

/**
 * Plugin definition matching OpenClaw plugin structure.
 */
export interface Plugin {
  id: string;
  name: string;
  kind: string;
  configSchema: typeof configSchema;
  register: (api: OpenClawPluginApi) => Promise<void>;
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
 * DecayService - Background service for automatic memory tier decay, promotion, and tuning.
 *
 * This service runs the DecayEngine, PromotionEngine, and TuningEngine on a configurable interval
 * to automatically demote stale memories, promote frequently-used ones, and auto-adjust parameters.
 */
class DecayService {
  private db: ReturnType<Database["getDb"]>;
  private config: ResolvedConfig;
  private decayEngine: DecayEngine;
  private promotionEngine: PromotionEngine;
  private tuningEngine: TuningEngine;
  private tuningReporter: TuningReporter;
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
    this.tuningEngine = new TuningEngine(db, config);
    this.tuningReporter = new TuningReporter(db, config);
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
   * Run one cycle of decay, promotion, and tuning.
   * Called on each interval tick.
   */
  private runCycle(): void {
    // Run decay engine first (demote stale memories)
    this.decayEngine.run();
    // Then run promotion engine (promote frequently-used memories)
    this.promotionEngine.run();
    // Finally run tuning engine (auto-adjust parameters based on tier sizes)
    const tuningResult = this.tuningEngine.run();

    // Report any tuning adjustments
    if (tuningResult.adjusted) {
      const tierCounts = this.tuningEngine.getTierCounts();
      for (const adjustment of tuningResult.adjustments) {
        this.tuningReporter.report(adjustment, tierCounts);
      }
    }
  }
}

/**
 * Plugin definition for the tiered memory system.
 */
const plugin: Plugin = {
  id: "tram",
  name: "TRAM",
  kind: "memory",
  configSchema,

  async register(api: OpenClawPluginApi): Promise<void> {
    // Parse and resolve configuration from api.pluginConfig
    const rawConfig = api.pluginConfig;
    const parsedConfig = configSchema.parse(rawConfig ?? {}) as MemoryTieredConfig;
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
    const tuneTool = new MemoryTuneTool(db, config);

    // Register all 9 tools using OpenClaw's expected format
    api.registerTool({
      name: "memory_store",
      label: "Memory Store",
      description: "Store a new memory in the tiered memory system with automatic deduplication.",
      parameters: Type.Object({
        text: Type.String({ description: "The memory content text (required)" }),
        tier: Type.Optional(Type.String({ description: "Initial tier: HOT or WARM" })),
        memory_type: Type.Optional(Type.String({ description: "Type: procedural, factual, project, episodic" })),
        importance: Type.Optional(Type.Number({ description: "Importance score 0.0 to 1.0" })),
        pinned: Type.Optional(Type.Boolean({ description: "Whether to pin this memory" })),
        category: Type.Optional(Type.String({ description: "Category for grouping" })),
        source: Type.Optional(Type.String({ description: "Origin of the memory" })),
      }),
      async execute(_toolCallId, params) {
        // Get session's default tier when no explicit tier is provided
        const inputParams = params as Record<string, unknown>;
        if (inputParams.tier === undefined) {
          const sessionType = getCurrentSessionType();
          const sessionConfig = config.sessions[sessionType];
          inputParams._sessionDefaultTier = sessionConfig.defaultTier;
        }
        const result = await storeTool.execute(inputParams as unknown as Parameters<typeof storeTool.execute>[0]);
        return { content: result.content, details: (result as {details?: unknown}).details };
      },
    });

    api.registerTool({
      name: "memory_recall",
      label: "Memory Recall",
      description: "Search and retrieve relevant memories using hybrid text and semantic search.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query text" }),
        limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
        tier: Type.Optional(Type.String({ description: "Filter by tier" })),
        includeArchive: Type.Optional(Type.Boolean({ description: "Include ARCHIVE tier" })),
        includeForgotten: Type.Optional(Type.Boolean({ description: "Include forgotten memories" })),
      }),
      async execute(_toolCallId, params) {
        const result = await recallTool.execute(params as unknown as Parameters<typeof recallTool.execute>[0]);
        // Format memories into content text for the agent to see
        let contentText = result.content[0]?.text || "No memories found.";
        if (result.memories && result.memories.length > 0) {
          const memoryLines = result.memories.map((m, i) =>
            `${i + 1}. [${m.id}] ${m.text.substring(0, 200)}${m.text.length > 200 ? "..." : ""} (score: ${m.score.toFixed(2)}, tier: ${m.tier})`
          );
          contentText = `${contentText}\n\n${memoryLines.join("\n")}`;
        }
        return { content: [{ type: "text", text: contentText }], details: result.memories };
      },
    });

    api.registerTool({
      name: "memory_forget",
      label: "Memory Forget",
      description: "Forget a memory (soft forget by default, reversible). Use hard=true for permanent deletion.",
      parameters: Type.Object({
        memoryId: Type.Optional(Type.String({ description: "Specific memory ID to forget" })),
        query: Type.Optional(Type.String({ description: "Search query to find memory" })),
        hard: Type.Optional(Type.Boolean({ description: "Permanently delete instead of soft forget" })),
      }),
      async execute(_toolCallId, params) {
        const result = await forgetTool.execute(params as unknown as Parameters<typeof forgetTool.execute>[0]);
        return { content: result.content, details: (result as {details?: unknown}).details };
      },
    });

    api.registerTool({
      name: "memory_restore",
      label: "Memory Restore",
      description: "Restore a forgotten memory, re-enabling it for context injection.",
      parameters: Type.Object({
        memoryId: Type.String({ description: "Memory ID to restore" }),
      }),
      async execute(_toolCallId, params) {
        const result = await restoreTool.execute(params as unknown as Parameters<typeof restoreTool.execute>[0]);
        return { content: result.content, details: (result as {details?: unknown}).details };
      },
    });

    api.registerTool({
      name: "memory_pin",
      label: "Memory Pin",
      description: "Pin a memory to bypass decay and prioritize for injection.",
      parameters: Type.Object({
        memoryId: Type.String({ description: "Memory ID to pin" }),
      }),
      async execute(_toolCallId, params) {
        const result = await pinTool.execute(params as unknown as Parameters<typeof pinTool.execute>[0]);
        return { content: result.content, details: (result as {details?: unknown}).details };
      },
    });

    api.registerTool({
      name: "memory_unpin",
      label: "Memory Unpin",
      description: "Unpin a memory so it follows normal decay rules.",
      parameters: Type.Object({
        memoryId: Type.String({ description: "Memory ID to unpin" }),
      }),
      async execute(_toolCallId, params) {
        const result = await unpinTool.execute(params as unknown as Parameters<typeof unpinTool.execute>[0]);
        return { content: result.content, details: (result as {details?: unknown}).details };
      },
    });

    api.registerTool({
      name: "memory_explain",
      label: "Memory Explain",
      description: "Explain how a memory is scored and whether it's eligible for context injection.",
      parameters: Type.Object({
        memoryId: Type.String({ description: "Memory ID to explain" }),
        query: Type.Optional(Type.String({ description: "Optional query for similarity calculation" })),
      }),
      async execute(_toolCallId, params) {
        const result = await explainTool.execute(params as unknown as Parameters<typeof explainTool.execute>[0]);
        return { content: result.content, details: (result as {details?: unknown}).details };
      },
    });

    api.registerTool({
      name: "memory_set_context",
      label: "Memory Set Context",
      description: "Set the current active task context for automatic recall.",
      parameters: Type.Object({
        text: Type.String({ description: "The context text" }),
        ttlHours: Type.Optional(Type.Number({ description: "Time-to-live in hours (default: 4)" })),
      }),
      async execute(_toolCallId, params) {
        const result = await setContextTool.execute(params as unknown as Parameters<typeof setContextTool.execute>[0]);
        return { content: result.content, details: (result as {details?: unknown}).details };
      },
    });

    api.registerTool({
      name: "memory_clear_context",
      label: "Memory Clear Context",
      description: "Clear the current active task context.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params) {
        const result = await clearContextTool.execute();
        return { content: result.content, details: (result as {details?: unknown}).details };
      },
    });

    api.registerTool({
      name: "memory_tune",
      label: "Memory Tune",
      description: "Adjust memory retrieval, decay, or promotion profiles at runtime. Use without arguments to see current settings.",
      parameters: Type.Object({
        retrieval: Type.Optional(Type.String({ description: "Retrieval profile name (narrow, focused, balanced, broad, expansive)" })),
        decay: Type.Optional(Type.String({ description: "Decay profile name (forgetful, casual, attentive, thorough, retentive)" })),
        promotion: Type.Optional(Type.String({ description: "Promotion profile name (forgiving, fair, selective, demanding, ruthless)" })),
        persist: Type.Optional(Type.Boolean({ description: "Save to config (requires scope)" })),
        scope: Type.Optional(Type.String({ description: "Where to persist: session (default), agent, or global" })),
      }),
      async execute(_toolCallId, params) {
        const result = await tuneTool.execute(params as unknown as Parameters<typeof tuneTool.execute>[0]);
        return { content: result.content, details: result.details };
      },
    });

    // Register plugin hooks with OpenClaw's typed hook system using api.on()
    // The api.on() method registers to typedHooks which the hook runner checks
    // Event names: before_agent_start (for recall), agent_end (for capture)
    if (typeof (api as any).on === "function") {
      // Register auto-recall hook for before_agent_start event
      (api as any).on("before_agent_start", autoRecallHandler);
      // Register auto-capture hook for agent_end event
      (api as any).on("agent_end", autoCaptureHandler);
    } else {
      console.warn("[TRAM] api.on not available - hooks will not fire");
    }

    // Initialize hooks with dependencies (database, providers, config)
    // The hook handlers use module-level state that must be set before events fire
    initAutoRecallHook(db, embeddingProvider, vectorHelper, config);
    initAutoCaptureHook(db, embeddingProvider, vectorHelper, config);
    console.log("[TRAM] Registered and initialized hooks (auto-recall, auto-capture)");

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
    const lockCommand = new MemoryLockCommand(db, config);

    // Register CLI commands using Commander.js callback pattern
    // See: https://docs.openclaw.ai/plugin - CLI Registration section
    // OpenClaw flattens plugin commands to root level, so we use tram-* prefix
    api.registerCli(
      ({ program }) => {
        // tram-search <query>
        program
          .command("tram-search <query>")
          .description("Search memories using hybrid text and semantic search")
          .option("--deep", "Include ARCHIVE tier memories")
          .option("--tier <tier>", "Filter by tier (HOT, WARM, COLD, ARCHIVE)")
          .option("--limit <n>", "Maximum number of results", "10")
          .option("--json", "Output as JSON")
          .option("--explain", "Show scoring breakdown for each result")
          .action(async (query: string, opts: Record<string, unknown>) => {
            const result = await searchCommand.execute(query, {
              deep: opts.deep as boolean | undefined,
              tier: opts.tier as "HOT" | "WARM" | "COLD" | "ARCHIVE" | undefined,
              limit: opts.limit ? parseInt(opts.limit as string, 10) : undefined,
              json: opts.json as boolean | undefined,
              explain: opts.explain as boolean | undefined,
            });
            console.log(result);
          });

        // memory list
        program
          .command("tram-list")
          .description("List memories by tier with optional filters")
          .option("--tier <tier>", "Filter by tier (HOT, WARM, COLD, ARCHIVE)")
          .option("--forgotten", "Show only forgotten memories")
          .option("--pinned", "Show only pinned memories")
          .option("--sort <field>", "Sort by field (created_at, last_accessed_at, use_count)")
          .option("--limit <n>", "Maximum number of results", "20")
          .option("--json", "Output as JSON")
          .action(async (opts: Record<string, unknown>) => {
            const result = await listCommand.execute({
              tier: opts.tier as "HOT" | "WARM" | "COLD" | "ARCHIVE" | undefined,
              forgotten: opts.forgotten as boolean | undefined,
              pinned: opts.pinned as boolean | undefined,
              sort: opts.sort as "created_at" | "last_accessed_at" | "use_count" | undefined,
              limit: opts.limit ? parseInt(opts.limit as string, 10) : undefined,
              json: opts.json as boolean | undefined,
            });
            console.log(result);
          });

        // memory stats
        program
          .command("tram-stats")
          .description("Display memory statistics and system information")
          .option("--json", "Output as JSON")
          .option("--metrics", "Show tuning metrics dashboard (injection usefulness, config vs targets, recent changes)")
          .action(async (opts: Record<string, unknown>) => {
            const result = await statsCommand.execute({
              json: opts.json as boolean | undefined,
              metrics: opts.metrics as boolean | undefined,
            });
            console.log(result);
          });

        // memory forget <idOrQuery>
        program
          .command("tram-forget <idOrQuery>")
          .description("Forget a memory (soft forget by default, reversible)")
          .option("--hard", "Permanently delete instead of soft forget")
          .option("--confirm", "Confirm hard deletion (required with --hard)")
          .option("--json", "Output as JSON")
          .action(async (idOrQuery: string, opts: Record<string, unknown>) => {
            const result = await forgetCommand.execute(idOrQuery, {
              hard: opts.hard as boolean | undefined,
              confirm: opts.confirm as boolean | undefined,
              json: opts.json as boolean | undefined,
            });
            console.log(result);
          });

        // memory restore <id>
        program
          .command("tram-restore <id>")
          .description("Restore a forgotten memory")
          .option("--json", "Output as JSON")
          .action(async (id: string, opts: Record<string, unknown>) => {
            const result = await restoreCommand.execute(id, {
              json: opts.json as boolean | undefined,
            });
            console.log(result);
          });

        // memory pin <id>
        program
          .command("tram-pin <id>")
          .description("Pin a memory to bypass decay and prioritize for injection")
          .option("--json", "Output as JSON")
          .action(async (id: string, opts: Record<string, unknown>) => {
            const result = await pinCommand.execute(id, {
              json: opts.json as boolean | undefined,
            });
            console.log(result);
          });

        // memory unpin <id>
        program
          .command("tram-unpin <id>")
          .description("Unpin a memory so it follows normal decay rules")
          .option("--json", "Output as JSON")
          .action(async (id: string, opts: Record<string, unknown>) => {
            const result = await unpinCommand.execute(id, {
              json: opts.json as boolean | undefined,
            });
            console.log(result);
          });

        // memory explain <id>
        program
          .command("tram-explain <id>")
          .description("Explain how a memory is scored and its injection eligibility")
          .option("--query <query>", "Query for similarity calculation")
          .option("--json", "Output as JSON")
          .action(async (id: string, opts: Record<string, unknown>) => {
            const result = await explainCommand.execute(id, {
              query: opts.query as string | undefined,
              json: opts.json as boolean | undefined,
            });
            console.log(result);
          });

        // memory set-context <text>
        program
          .command("tram-set-context <text>")
          .description("Set the current active task context for automatic recall")
          .option("--ttl <hours>", "Time-to-live in hours", "4")
          .option("--json", "Output as JSON")
          .action(async (text: string, opts: Record<string, unknown>) => {
            const result = await setContextCommand.execute(text, {
              ttl: opts.ttl ? parseInt(opts.ttl as string, 10) : undefined,
              json: opts.json as boolean | undefined,
            });
            console.log(result);
          });

        // memory clear-context
        program
          .command("tram-clear-context")
          .description("Clear the current active task context")
          .option("--json", "Output as JSON")
          .action(async (opts: Record<string, unknown>) => {
            const result = await clearContextCommand.execute({
              json: opts.json as boolean | undefined,
            });
            console.log(result);
          });

        // memory decay <action>
        program
          .command("tram-decay <action>")
          .description("Manually trigger decay and promotion cycle (action: run)")
          .option("--json", "Output as JSON")
          .action(async (action: string, opts: Record<string, unknown>) => {
            if (action !== "run") {
              console.log(`Unknown decay action: ${action}. Use 'run' to trigger decay.`);
              return;
            }
            const result = await decayCommand.execute({
              json: opts.json as boolean | undefined,
            });
            console.log(result);
          });

        // memory index
        program
          .command("tram-index")
          .description("Index legacy memory files (MEMORY.md, memory/*.md) into the tiered system")
          .option("--force", "Re-index all files (ignore hash check)")
          .option("--json", "Output as JSON")
          .action(async (opts: Record<string, unknown>) => {
            const result = await indexCommand.execute({
              force: opts.force as boolean | undefined,
              json: opts.json as boolean | undefined,
            });
            console.log(result);
          });

        // memory migrate
        program
          .command("tram-migrate")
          .description("Migrate memory data from external sources (e.g., LanceDB)")
          .option("--from <source>", "Source to migrate from (currently only 'lancedb' supported)", "lancedb")
          .option("--preview", "Show migration plan without executing")
          .option("--rollback", "Rollback to previous backup (restores original LanceDB)")
          .option("--json", "Output as JSON")
          .action(async (opts: Record<string, unknown>) => {
            const result = await migrateCommand.execute({
              from: opts.from as string | undefined,
              preview: opts.preview as boolean | undefined,
              rollback: opts.rollback as boolean | undefined,
              json: opts.json as boolean | undefined,
            });
            console.log(result);
          });

        // tram lock <parameter>
        program
          .command("tram-lock <parameter>")
          .description("Lock a parameter to prevent auto-tuning")
          .option("--json", "Output as JSON")
          .action((parameter: string, opts: Record<string, unknown>) => {
            const result = lockCommand.lock(parameter, {
              json: opts.json as boolean | undefined,
            });
            console.log(result);
          });

        // tram unlock <parameter>
        program
          .command("tram-unlock <parameter>")
          .description("Unlock a parameter to allow auto-tuning")
          .option("--json", "Output as JSON")
          .action((parameter: string, opts: Record<string, unknown>) => {
            const result = lockCommand.unlock(parameter, {
              json: opts.json as boolean | undefined,
            });
            console.log(result);
          });
      },
      { commands: ["tram-search", "tram-list", "tram-stats", "tram-forget", "tram-restore", "tram-pin", "tram-unpin", "tram-explain", "tram-set-context", "tram-clear-context", "tram-decay", "tram-index", "tram-migrate", "tram-lock", "tram-unlock"] }
    );

    // Create and register the decay service
    const decayService = new DecayService(db, config);
    api.registerService({
      id: "tram-decay",
      description: "Background service for automatic memory tier decay and promotion",
      start: () => decayService.start(),
      stop: () => decayService.stop(),
    });
  },
};

export default plugin;
