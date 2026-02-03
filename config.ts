/**
 * Configuration schema for the tiered memory plugin.
 * Uses Zod for validation with UI hints for the OpenClaw config UI.
 */

import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Supported embedding providers
 */
export const EmbeddingProviderSchema = z.enum([
  "local",
  "openai",
  "gemini",
  "auto",
]);
export type EmbeddingProvider = z.infer<typeof EmbeddingProviderSchema>;

/**
 * Local embedding settings schema
 */
export const LocalEmbeddingSchema = z.object({
  /** Path to the local model (e.g., 'Xenova/all-MiniLM-L6-v2') */
  modelPath: z.string().default("Xenova/all-MiniLM-L6-v2"),
});

/**
 * Embedding configuration options
 */
export const EmbeddingConfigSchema = z.object({
  /** Which embedding provider to use */
  provider: EmbeddingProviderSchema.default("auto"),
  /** API key for cloud providers (OpenAI, Gemini) */
  apiKey: z.string().optional(),
  /** Model identifier for the embedding provider */
  model: z.string().optional(),
  /** Local embedding settings */
  local: LocalEmbeddingSchema.optional(),
});
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;

/**
 * HOT tier configuration
 */
export const HotTierConfigSchema = z.object({
  /** Hours before HOT memories demote to COLD (default 72 hours) */
  ttlHours: z.number().min(1).default(72),
});

/**
 * WARM tier configuration
 */
export const WarmTierConfigSchema = z.object({
  /** Days of inactivity before WARM demotes to COLD (default 60 days) */
  demotionDays: z.number().min(1).default(60),
});

/**
 * COLD tier configuration
 */
export const ColdTierConfigSchema = z.object({
  /** Minimum uses required for promotion to WARM (default 3) */
  promotionUses: z.number().min(1).default(3),
  /** Minimum distinct days of use for promotion to WARM (default 2) */
  promotionDays: z.number().min(1).default(2),
});

/**
 * Tier-specific configuration
 */
export const TiersConfigSchema = z.object({
  hot: HotTierConfigSchema.optional(),
  warm: WarmTierConfigSchema.optional(),
  cold: ColdTierConfigSchema.optional(),
});
export type TiersConfig = z.infer<typeof TiersConfigSchema>;

/**
 * Scoring weights for memory ranking
 */
export const ScoringConfigSchema = z.object({
  /** Weight for similarity score (0.0 to 1.0, default 0.5) */
  similarity: z.number().min(0).max(1).default(0.5),
  /** Weight for recency score (0.0 to 1.0, default 0.3) */
  recency: z.number().min(0).max(1).default(0.3),
  /** Weight for frequency score (0.0 to 1.0, default 0.2) */
  frequency: z.number().min(0).max(1).default(0.2),
});
export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

/**
 * Budget percentages for tier-based injection allocation
 */
export const BudgetsConfigSchema = z.object({
  /** Percentage of slots for pinned memories (default 25) */
  pinned: z.number().min(0).max(100).default(25),
  /** Percentage of slots for HOT tier (default 45) */
  hot: z.number().min(0).max(100).default(45),
  /** Percentage of slots for WARM tier (default 25) */
  warm: z.number().min(0).max(100).default(25),
  /** Percentage of slots for COLD tier (default 5) */
  cold: z.number().min(0).max(100).default(5),
});
export type BudgetsConfig = z.infer<typeof BudgetsConfigSchema>;

/**
 * Injection configuration for context assembly
 */
export const InjectionConfigSchema = z.object({
  /** Maximum number of memories to inject (default 20) */
  maxItems: z.number().min(1).default(20),
  /** Minimum composite score for memory to be injected (default 0.2) */
  minScore: z.number().min(0).max(1).default(0.2),
  /** Budget percentages by tier */
  budgets: BudgetsConfigSchema.optional(),
});
export type InjectionConfig = z.infer<typeof InjectionConfigSchema>;

/**
 * Auto-recall configuration when using object form.
 * Allows fine-grained control over auto-recall behavior.
 */
export const AutoRecallObjectConfigSchema = z.object({
  /** Whether auto-recall is enabled (default: true) */
  enabled: z.boolean().default(true),
  /** Minimum composite score for memory to be injected (default 0.2) */
  minScore: z.number().min(0).max(1).optional(),
  /** Maximum number of memories to inject */
  maxItems: z.number().min(1).optional(),
  /** Budget percentages by tier (override injection.budgets) */
  budgets: BudgetsConfigSchema.optional(),
});
export type AutoRecallObjectConfig = z.infer<typeof AutoRecallObjectConfigSchema>;

/**
 * Auto-recall configuration schema.
 * Accepts either:
 * - boolean: true enables with defaults, false disables
 * - object: fine-grained control over auto-recall settings
 */
export const AutoRecallConfigSchema = z.union([
  z.boolean(),
  AutoRecallObjectConfigSchema,
]);
export type AutoRecallConfig = z.infer<typeof AutoRecallConfigSchema>;

/**
 * Decay service configuration
 */
export const DecayConfigSchema = z.object({
  /** Hours between decay runs (default 6) */
  intervalHours: z.number().min(1).default(6),
});
export type DecayConfig = z.infer<typeof DecayConfigSchema>;

/**
 * Current context configuration
 */
export const ContextConfigSchema = z.object({
  /** Default TTL in hours for current context (default 4) */
  ttlHours: z.number().min(0.1).default(4),
});
export type ContextConfig = z.infer<typeof ContextConfigSchema>;

/**
 * Default database path
 */
const DEFAULT_DB_PATH = join(homedir(), ".openclaw", "memory", "tiered.db");

/**
 * Complete plugin configuration schema
 */
export const MemoryTieredConfigSchema = z.object({
  /** Embedding provider and model settings */
  embedding: EmbeddingConfigSchema.optional(),
  /** Path to the SQLite database file */
  dbPath: z.string().default(DEFAULT_DB_PATH),
  /** Automatically capture important information from conversations */
  autoCapture: z.boolean().default(true),
  /** Automatically recall relevant memories before agent responses.
   *  - boolean `true`: enable with defaults
   *  - boolean `false`: disable auto-recall
   *  - object: fine-grained control (enabled, minScore, maxItems, budgets)
   */
  autoRecall: AutoRecallConfigSchema.default(true),
  /** Tier-specific settings */
  tiers: TiersConfigSchema.optional(),
  /** Scoring weights for memory ranking */
  scoring: ScoringConfigSchema.optional(),
  /** Injection settings for context assembly */
  injection: InjectionConfigSchema.optional(),
  /** Decay service settings */
  decay: DecayConfigSchema.optional(),
  /** Current context settings */
  context: ContextConfigSchema.optional(),
});

export type MemoryTieredConfig = z.infer<typeof MemoryTieredConfigSchema>;

/**
 * Resolved auto-recall configuration with all defaults applied
 */
export interface ResolvedAutoRecallConfig {
  /** Whether auto-recall is enabled */
  enabled: boolean;
  /** Minimum composite score for memory to be injected */
  minScore: number;
  /** Maximum number of memories to inject */
  maxItems: number;
  /** Budget percentages by tier */
  budgets: { pinned: number; hot: number; warm: number; cold: number };
}

/**
 * Resolved configuration with all defaults applied
 */
export interface ResolvedConfig {
  embedding: {
    provider: EmbeddingProvider;
    apiKey?: string;
    model?: string;
    local: { modelPath: string };
  };
  dbPath: string;
  autoCapture: boolean;
  /** Resolved auto-recall configuration (always an object) */
  autoRecall: ResolvedAutoRecallConfig;
  tiers: {
    hot: { ttlHours: number };
    warm: { demotionDays: number };
    cold: { promotionUses: number; promotionDays: number };
  };
  scoring: { similarity: number; recency: number; frequency: number };
  injection: {
    maxItems: number;
    minScore: number;
    budgets: { pinned: number; hot: number; warm: number; cold: number };
  };
  decay: { intervalHours: number };
  context: { ttlHours: number };
}

/**
 * Default configuration values
 */
const DEFAULTS = {
  embedding: {
    provider: "auto" as const,
    local: { modelPath: "Xenova/all-MiniLM-L6-v2" },
  },
  dbPath: DEFAULT_DB_PATH,
  autoCapture: true,
  autoRecall: {
    enabled: true,
    minScore: 0.2,
    maxItems: 20,
    budgets: { pinned: 25, hot: 45, warm: 25, cold: 5 },
  },
  tiers: {
    hot: { ttlHours: 72 },
    warm: { demotionDays: 60 },
    cold: { promotionUses: 3, promotionDays: 2 },
  },
  scoring: { similarity: 0.5, recency: 0.3, frequency: 0.2 },
  injection: {
    maxItems: 20,
    minScore: 0.2,
    budgets: { pinned: 25, hot: 45, warm: 25, cold: 5 },
  },
  decay: { intervalHours: 6 },
  context: { ttlHours: 4 },
} as const;

/**
 * Resolve autoRecall configuration from boolean or object input.
 * @param autoRecall - The raw autoRecall config (boolean or object)
 * @param injection - The resolved injection config (for fallback values)
 * @returns Fully resolved autoRecall configuration object
 */
function resolveAutoRecall(
  autoRecall: AutoRecallConfig | undefined,
  injection: ResolvedConfig["injection"]
): ResolvedAutoRecallConfig {
  // Default case: undefined means enabled with defaults
  if (autoRecall === undefined) {
    return { ...DEFAULTS.autoRecall };
  }

  // Boolean case: true = enabled with defaults, false = disabled
  if (typeof autoRecall === "boolean") {
    return {
      enabled: autoRecall,
      minScore: DEFAULTS.autoRecall.minScore,
      maxItems: DEFAULTS.autoRecall.maxItems,
      budgets: { ...DEFAULTS.autoRecall.budgets },
    };
  }

  // Object case: merge with defaults, use injection config as fallback
  return {
    enabled: autoRecall.enabled ?? true,
    minScore: autoRecall.minScore ?? injection.minScore,
    maxItems: autoRecall.maxItems ?? injection.maxItems,
    budgets: {
      pinned: autoRecall.budgets?.pinned ?? injection.budgets.pinned,
      hot: autoRecall.budgets?.hot ?? injection.budgets.hot,
      warm: autoRecall.budgets?.warm ?? injection.budgets.warm,
      cold: autoRecall.budgets?.cold ?? injection.budgets.cold,
    },
  };
}

/**
 * Apply defaults to parsed config, filling in missing values
 */
export function resolveConfig(config: MemoryTieredConfig): ResolvedConfig {
  // Resolve injection first so we can use it for autoRecall fallbacks
  const injection = {
    maxItems: config.injection?.maxItems ?? DEFAULTS.injection.maxItems,
    minScore: config.injection?.minScore ?? DEFAULTS.injection.minScore,
    budgets: {
      pinned:
        config.injection?.budgets?.pinned ?? DEFAULTS.injection.budgets.pinned,
      hot: config.injection?.budgets?.hot ?? DEFAULTS.injection.budgets.hot,
      warm: config.injection?.budgets?.warm ?? DEFAULTS.injection.budgets.warm,
      cold: config.injection?.budgets?.cold ?? DEFAULTS.injection.budgets.cold,
    },
  };

  return {
    embedding: {
      provider: config.embedding?.provider ?? DEFAULTS.embedding.provider,
      apiKey: config.embedding?.apiKey,
      model: config.embedding?.model,
      local: {
        modelPath:
          config.embedding?.local?.modelPath ??
          DEFAULTS.embedding.local.modelPath,
      },
    },
    dbPath: config.dbPath ?? DEFAULTS.dbPath,
    autoCapture: config.autoCapture ?? DEFAULTS.autoCapture,
    autoRecall: resolveAutoRecall(config.autoRecall, injection),
    tiers: {
      hot: {
        ttlHours: config.tiers?.hot?.ttlHours ?? DEFAULTS.tiers.hot.ttlHours,
      },
      warm: {
        demotionDays:
          config.tiers?.warm?.demotionDays ?? DEFAULTS.tiers.warm.demotionDays,
      },
      cold: {
        promotionUses:
          config.tiers?.cold?.promotionUses ??
          DEFAULTS.tiers.cold.promotionUses,
        promotionDays:
          config.tiers?.cold?.promotionDays ??
          DEFAULTS.tiers.cold.promotionDays,
      },
    },
    scoring: {
      similarity:
        config.scoring?.similarity ?? DEFAULTS.scoring.similarity,
      recency: config.scoring?.recency ?? DEFAULTS.scoring.recency,
      frequency: config.scoring?.frequency ?? DEFAULTS.scoring.frequency,
    },
    injection,
    decay: {
      intervalHours:
        config.decay?.intervalHours ?? DEFAULTS.decay.intervalHours,
    },
    context: {
      ttlHours: config.context?.ttlHours ?? DEFAULTS.context.ttlHours,
    },
  };
}

/**
 * UI hints for the OpenClaw configuration interface.
 * Provides labels, descriptions, and input types for each field.
 */
export const uiHints = {
  embedding: {
    label: "Embedding Settings",
    description:
      "Configure how memories are converted to vectors for semantic search",
    fields: {
      provider: {
        label: "Embedding Provider",
        description:
          "Choose the embedding provider. 'auto' will use local embeddings if available, otherwise fall back to OpenAI.",
        type: "select",
        options: [
          { value: "auto", label: "Auto (local preferred)" },
          { value: "local", label: "Local (offline, uses transformers.js)" },
          { value: "openai", label: "OpenAI (requires API key)" },
          { value: "gemini", label: "Gemini (requires API key)" },
        ],
      },
      apiKey: {
        label: "API Key",
        description: "API key for cloud embedding providers (OpenAI or Gemini)",
        type: "password",
        dependsOn: {
          field: "embedding.provider",
          values: ["openai", "gemini", "auto"],
        },
      },
      model: {
        label: "Model",
        description:
          "Model to use for embeddings (e.g., 'text-embedding-3-small' for OpenAI)",
        type: "text",
        placeholder: "text-embedding-3-small",
      },
      local: {
        label: "Local Embedding Settings",
        fields: {
          modelPath: {
            label: "Model Path",
            description: "HuggingFace model ID for local embeddings",
            type: "text",
            placeholder: "Xenova/all-MiniLM-L6-v2",
          },
        },
      },
    },
  },
  dbPath: {
    label: "Database Path",
    description: "Path to the SQLite database file for storing memories",
    type: "text",
    placeholder: DEFAULT_DB_PATH,
  },
  autoCapture: {
    label: "Auto-Capture",
    description: "Automatically capture important information from conversations",
    type: "toggle",
  },
  autoRecall: {
    label: "Auto-Recall",
    description: "Automatically inject relevant memories into agent context",
    type: "toggle",
  },
  tiers: {
    label: "Tier Settings",
    description: "Configure tier thresholds and behavior",
    fields: {
      hot: {
        label: "HOT Tier",
        fields: {
          ttlHours: {
            label: "TTL (hours)",
            description: "Hours before HOT memories demote to COLD",
            type: "number",
            min: 1,
            placeholder: "72",
          },
        },
      },
      warm: {
        label: "WARM Tier",
        fields: {
          demotionDays: {
            label: "Demotion Days",
            description: "Days of inactivity before WARM demotes to COLD",
            type: "number",
            min: 1,
            placeholder: "60",
          },
        },
      },
      cold: {
        label: "COLD Tier",
        fields: {
          promotionUses: {
            label: "Promotion Uses",
            description: "Minimum uses required for promotion to WARM",
            type: "number",
            min: 1,
            placeholder: "3",
          },
          promotionDays: {
            label: "Promotion Days",
            description: "Minimum distinct days of use for promotion to WARM",
            type: "number",
            min: 1,
            placeholder: "2",
          },
        },
      },
    },
  },
  scoring: {
    label: "Scoring Weights",
    description: "Weights for the composite memory ranking formula",
    fields: {
      similarity: {
        label: "Similarity Weight",
        description: "Weight for semantic similarity score (0.0 to 1.0)",
        type: "slider",
        min: 0,
        max: 1,
        step: 0.05,
        placeholder: "0.5",
      },
      recency: {
        label: "Recency Weight",
        description: "Weight for recency score (0.0 to 1.0)",
        type: "slider",
        min: 0,
        max: 1,
        step: 0.05,
        placeholder: "0.3",
      },
      frequency: {
        label: "Frequency Weight",
        description: "Weight for access frequency score (0.0 to 1.0)",
        type: "slider",
        min: 0,
        max: 1,
        step: 0.05,
        placeholder: "0.2",
      },
    },
  },
  injection: {
    label: "Injection Settings",
    description: "Configure memory injection into agent context",
    fields: {
      maxItems: {
        label: "Max Items",
        description: "Maximum number of memories to inject",
        type: "number",
        min: 1,
        placeholder: "20",
      },
      minScore: {
        label: "Min Score",
        description:
          "Minimum composite score required for a memory to be injected (0.0 to 1.0)",
        type: "slider",
        min: 0,
        max: 1,
        step: 0.05,
        placeholder: "0.2",
      },
      budgets: {
        label: "Budget Allocation (%)",
        description: "Percentage of slots allocated to each tier",
        fields: {
          pinned: {
            label: "Pinned",
            description: "Percentage for pinned memories",
            type: "number",
            min: 0,
            max: 100,
            placeholder: "25",
          },
          hot: {
            label: "HOT",
            description: "Percentage for HOT tier",
            type: "number",
            min: 0,
            max: 100,
            placeholder: "45",
          },
          warm: {
            label: "WARM",
            description: "Percentage for WARM tier",
            type: "number",
            min: 0,
            max: 100,
            placeholder: "25",
          },
          cold: {
            label: "COLD",
            description: "Percentage for COLD tier",
            type: "number",
            min: 0,
            max: 100,
            placeholder: "5",
          },
        },
      },
    },
  },
  decay: {
    label: "Decay Settings",
    description: "Configure the background decay service",
    fields: {
      intervalHours: {
        label: "Interval (hours)",
        description: "Hours between decay runs",
        type: "number",
        min: 1,
        placeholder: "6",
      },
    },
  },
  context: {
    label: "Context Settings",
    description: "Configure current context behavior",
    fields: {
      ttlHours: {
        label: "Default TTL (hours)",
        description: "Default time-to-live for current context",
        type: "number",
        min: 0.1,
        step: 0.5,
        placeholder: "4",
      },
    },
  },
} as const;

/**
 * Parse configuration with validation
 */
export function parseConfig(input: unknown): MemoryTieredConfig {
  return MemoryTieredConfigSchema.parse(input ?? {});
}

/**
 * Safely parse configuration, returning defaults on error
 */
export function safeParseConfig(
  input: unknown
):
  | { success: true; data: MemoryTieredConfig }
  | { success: false; error: z.ZodError } {
  const result = MemoryTieredConfigSchema.safeParse(input);
  return result;
}

/**
 * Get default configuration (fully resolved)
 */
export function getDefaultConfig(): ResolvedConfig {
  return resolveConfig(MemoryTieredConfigSchema.parse({}));
}

/**
 * Export the config schema for OpenClaw plugin registration
 */
export const configSchema = {
  schema: MemoryTieredConfigSchema,
  parse: parseConfig,
  safeParse: safeParseConfig,
  resolve: resolveConfig,
  uiHints,
};
