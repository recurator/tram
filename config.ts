/**
 * Configuration schema for the tiered memory plugin.
 * Uses Zod for validation with UI hints for the OpenClaw config UI.
 */

import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Duration or number schema for TTL values (backwards compatible).
 * Accepts either a duration string ("1h", "7d") or a number.
 */
export const DurationOrNumberSchema = z.union([z.string(), z.number()]);

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
  /** Percentage of slots for ARCHIVE tier (default 0, never auto-injected) */
  archive: z.number().min(0).max(100).default(0),
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
 * Memory type enum values for decay overrides.
 * Must match MemoryType enum from core/types.ts.
 */
export const MemoryTypeSchema = z.enum([
  "factual",
  "procedural",
  "episodic",
  "project",
]);
export type MemoryTypeValue = z.infer<typeof MemoryTypeSchema>;

/**
 * Tier values for session configuration.
 * Must match Tier enum from core/types.ts.
 */
export const TierValueSchema = z.enum(["HOT", "WARM", "COLD", "ARCHIVE"]);
export type TierValue = z.infer<typeof TierValueSchema>;

/**
 * Session type enum values.
 */
export const SessionTypeSchema = z.enum(["main", "cron", "spawned"]);
export type SessionTypeValue = z.infer<typeof SessionTypeSchema>;

/**
 * Tuning mode enum values.
 * - auto: TRAM auto-adjusts parameters without user intervention
 * - manual: User must manually adjust parameters
 * - hybrid: TRAM suggests adjustments, auto-adjusts unless user has locked a parameter
 */
export const TuningModeSchema = z.enum(["auto", "manual", "hybrid"]);
export type TuningModeValue = z.infer<typeof TuningModeSchema>;

/**
 * Reporting channel enum values.
 * - telegram: Send notifications via Telegram bot
 * - discord: Send notifications via Discord webhook
 * - slack: Send notifications via Slack webhook
 * - log: Write notifications to log file
 * - none: Disable notifications
 */
export const ReportingChannelSchema = z.enum(["telegram", "discord", "slack", "log", "none"]);
export type ReportingChannelValue = z.infer<typeof ReportingChannelSchema>;

/**
 * Reporting frequency enum values.
 * - on-change: Send notification immediately when tuning changes occur
 * - daily-summary: Batch notifications into a daily summary
 * - weekly-summary: Batch notifications into a weekly summary
 */
export const ReportingFrequencySchema = z.enum(["on-change", "daily-summary", "weekly-summary"]);
export type ReportingFrequencyValue = z.infer<typeof ReportingFrequencySchema>;

/**
 * Retrieval profile preset names
 */
export const RetrievalProfileNameSchema = z.enum(["narrow", "focused", "balanced", "broad", "expansive"]);

/**
 * Decay profile preset names
 */
export const DecayProfileNameSchema = z.enum(["forgetful", "casual", "attentive", "thorough", "retentive"]);

/**
 * Promotion profile preset names
 */
export const PromotionProfileNameSchema = z.enum(["forgiving", "fair", "selective", "demanding", "ruthless"]);

/**
 * Agent-specific profile overrides
 */
export const AgentProfilesSchema = z.object({
  /** Retrieval profile for this agent */
  retrieval: z.string().optional(),
  /** Decay profile for this agent */
  decay: z.string().optional(),
  /** Promotion profile for this agent */
  promotion: z.string().optional(),
});
export type AgentProfiles = z.infer<typeof AgentProfilesSchema>;

/**
 * Custom retrieval profile definition
 */
export const CustomRetrievalProfileSchema = z.object({
  hot: z.number().min(0).max(100),
  warm: z.number().min(0).max(100),
  cold: z.number().min(0).max(100),
  archive: z.number().min(0).max(100),
});

/**
 * Custom decay profile definition
 */
export const CustomDecayProfileSchema = z.object({
  hotTtl: DurationOrNumberSchema,
  warmTtl: DurationOrNumberSchema,
  coldTtl: DurationOrNumberSchema,
});

/**
 * Custom promotion profile definition
 */
export const CustomPromotionProfileSchema = z.object({
  uses: z.number().min(1),
  days: z.number().min(1),
});

/**
 * Profile configuration schema for retrieval, decay, and promotion profiles
 */
export const ProfilesConfigSchema = z.object({
  /** Retrieval profile configuration */
  retrieval: z.object({
    /** Active profile name */
    profile: z.string().default("focused"),
    /** Custom profile definitions */
    profiles: z.record(z.string(), CustomRetrievalProfileSchema).optional(),
  }).optional(),
  /** Decay profile configuration */
  decay: z.object({
    /** Active profile name */
    profile: z.string().default("thorough"),
    /** Custom profile definitions */
    profiles: z.record(z.string(), CustomDecayProfileSchema).optional(),
  }).optional(),
  /** Promotion profile configuration */
  promotion: z.object({
    /** Active profile name */
    profile: z.string().default("selective"),
    /** Custom profile definitions */
    profiles: z.record(z.string(), CustomPromotionProfileSchema).optional(),
  }).optional(),
  /** Agent-specific profile overrides */
  agents: z.record(z.string(), AgentProfilesSchema).optional(),
});
export type ProfilesConfig = z.infer<typeof ProfilesConfigSchema>;

/**
 * Per-session-type configuration.
 */
export const SessionSettingsSchema = z.object({
  /** Default tier for memories captured in this session type */
  defaultTier: TierValueSchema,
  /** Whether auto-capture is enabled for this session type */
  autoCapture: z.boolean(),
  /** Whether auto-inject (auto-recall) is enabled for this session type */
  autoInject: z.boolean(),
});
export type SessionSettings = z.infer<typeof SessionSettingsSchema>;

/**
 * Sessions configuration schema.
 * Allows different behavior for main, cron, and spawned sessions.
 */
export const SessionsConfigSchema = z.object({
  /** Configuration for main (interactive) sessions */
  main: SessionSettingsSchema.optional(),
  /** Configuration for cron (scheduled) sessions */
  cron: SessionSettingsSchema.optional(),
  /** Configuration for spawned (child) sessions */
  spawned: SessionSettingsSchema.optional(),
});
export type SessionsConfig = z.infer<typeof SessionsConfigSchema>;

/**
 * Bounds schema for a tunable parameter.
 * Defines min, max, and step values for auto-adjustment.
 */
export const TuningBoundsSchema = z.object({
  /** Minimum allowed value */
  min: z.number(),
  /** Maximum allowed value */
  max: z.number(),
  /** Adjustment step size */
  step: z.number(),
});
export type TuningBounds = z.infer<typeof TuningBoundsSchema>;

/**
 * Auto-adjust configuration for tier size targets.
 * Specifies min/max target sizes for a tier.
 */
export const TierTargetSizeSchema = z.object({
  /** Minimum target size for the tier */
  min: z.number().min(0),
  /** Maximum target size for the tier */
  max: z.number().min(0),
});
export type TierTargetSize = z.infer<typeof TierTargetSizeSchema>;

/**
 * Auto-adjust settings for tuning parameters.
 * Defines bounds and target sizes for automatic parameter adjustment.
 */
export const AutoAdjustConfigSchema = z.object({
  /** Bounds for importanceThreshold parameter (used for tier promotion/demotion) */
  importanceThreshold: TuningBoundsSchema.optional(),
  /** Target size range for HOT tier */
  hotTargetSize: TierTargetSizeSchema.optional(),
  /** Target size range for WARM tier */
  warmTargetSize: TierTargetSizeSchema.optional(),
});
export type AutoAdjustConfig = z.infer<typeof AutoAdjustConfigSchema>;

/**
 * Tuning configuration schema.
 * Controls auto-adjustment behavior for memory tier management.
 */
export const TuningConfigSchema = z.object({
  /** Whether tuning is enabled (default true) */
  enabled: z.boolean().default(true),
  /** Tuning mode: auto, manual, or hybrid (default hybrid) */
  mode: TuningModeSchema.default("hybrid"),
  /** Auto-adjustment settings with parameter bounds */
  autoAdjust: AutoAdjustConfigSchema.optional(),
  /** Days to lock a parameter after user override (default 7) */
  lockDurationDays: z.number().min(1).default(7),
});
export type TuningConfig = z.infer<typeof TuningConfigSchema>;

/**
 * Reporting configuration schema.
 * Controls notifications when TRAM auto-tunes parameters.
 */
export const ReportingConfigSchema = z.object({
  /** Whether reporting is enabled (default true) */
  enabled: z.boolean().default(true),
  /** Notification channel: telegram, discord, slack, log, or none (default log) */
  channel: ReportingChannelSchema.default("log"),
  /** Notification frequency: on-change, daily-summary, or weekly-summary (default on-change) */
  frequency: ReportingFrequencySchema.default("on-change"),
  /** Whether to include metrics in notifications (default true) */
  includeMetrics: z.boolean().default(true),
});
export type ReportingConfig = z.infer<typeof ReportingConfigSchema>;

/**
 * TTL override for a specific memory type.
 * - hotTTL: Time before HOT memories demote (null = never demote)
 * - warmTTL: Time before WARM memories demote (null = never demote)
 * - coldTTL: Time before COLD memories demote to ARCHIVE (null = never demote)
 */
export const DecayTTLOverrideSchema = z.object({
  /** Time before HOT memories demote to WARM (hours, duration string, or null = no decay) */
  hotTTL: z.union([DurationOrNumberSchema, z.null()]),
  /** Time before WARM memories demote to COLD (days, duration string, or null = no decay) */
  warmTTL: z.union([DurationOrNumberSchema, z.null()]),
  /** Time before COLD memories demote to ARCHIVE (days, duration string, or null = no decay) */
  coldTTL: z.union([DurationOrNumberSchema, z.null()]).optional(),
});
export type DecayTTLOverride = z.infer<typeof DecayTTLOverrideSchema>;

/**
 * Default TTL values used when no override exists for a memory type.
 */
export const DecayDefaultsSchema = z.object({
  /** Default time before HOT memories demote to WARM (hours or duration string) */
  hotTTL: DurationOrNumberSchema.default(72),
  /** Default time before WARM memories demote to COLD (days or duration string) */
  warmTTL: DurationOrNumberSchema.default(60),
  /** Default time before COLD memories demote to ARCHIVE (days or duration string) */
  coldTTL: DurationOrNumberSchema.default(180),
});
export type DecayDefaults = z.infer<typeof DecayDefaultsSchema>;

/**
 * Decay service configuration
 */
export const DecayConfigSchema = z.object({
  /** Hours between decay runs (default 6) */
  intervalHours: z.number().min(1).default(6),
  /** Default TTL values when no override exists */
  default: DecayDefaultsSchema.optional(),
  /** Per-memory-type TTL overrides (keys: factual, procedural, episodic, project) */
  overrides: z.record(MemoryTypeSchema, DecayTTLOverrideSchema).optional(),
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
  /** Per-session-type settings (main, cron, spawned) */
  sessions: SessionsConfigSchema.optional(),
  /** Tuning settings for auto-adjustment */
  tuning: TuningConfigSchema.optional(),
  /** Reporting settings for notifications */
  reporting: ReportingConfigSchema.optional(),
  /** Profile settings for retrieval, decay, and promotion */
  profiles: ProfilesConfigSchema.optional(),
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
  budgets: { pinned: number; hot: number; warm: number; cold: number; archive: number };
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
    budgets: { pinned: number; hot: number; warm: number; cold: number; archive: number };
  };
  decay: {
    intervalHours: number;
    default: { hotTTL: string | number; warmTTL: string | number; coldTTL: string | number };
    overrides: Record<MemoryTypeValue, { hotTTL: string | number | null; warmTTL: string | number | null; coldTTL?: string | number | null }>;
  };
  profiles: {
    retrieval: { profile: string; profiles?: Record<string, { hot: number; warm: number; cold: number; archive: number }> };
    decay: { profile: string; profiles?: Record<string, { hotTtl: string | number; warmTtl: string | number; coldTtl: string | number }> };
    promotion: { profile: string; profiles?: Record<string, { uses: number; days: number }> };
    agents: Record<string, { retrieval?: string; decay?: string; promotion?: string }>;
  };
  context: { ttlHours: number };
  sessions: {
    main: { defaultTier: TierValue; autoCapture: boolean; autoInject: boolean };
    cron: { defaultTier: TierValue; autoCapture: boolean; autoInject: boolean };
    spawned: { defaultTier: TierValue; autoCapture: boolean; autoInject: boolean };
  };
  tuning: {
    enabled: boolean;
    mode: TuningModeValue;
    autoAdjust: {
      importanceThreshold: { min: number; max: number; step: number };
      hotTargetSize: { min: number; max: number };
      warmTargetSize: { min: number; max: number };
    };
    lockDurationDays: number;
  };
  reporting: {
    enabled: boolean;
    channel: ReportingChannelValue;
    frequency: ReportingFrequencyValue;
    includeMetrics: boolean;
  };
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
    budgets: { pinned: 25, hot: 45, warm: 25, cold: 5, archive: 0 },
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
    budgets: { pinned: 25, hot: 45, warm: 25, cold: 5, archive: 0 },
  },
  decay: {
    intervalHours: 6,
    default: { hotTTL: 72, warmTTL: 60, coldTTL: 180 },
    overrides: {} as Record<MemoryTypeValue, { hotTTL: string | number | null; warmTTL: string | number | null; coldTTL?: string | number | null }>,
  },
  profiles: {
    retrieval: { profile: "focused" },
    decay: { profile: "thorough" },
    promotion: { profile: "selective" },
    agents: {},
  },
  context: { ttlHours: 4 },
  sessions: {
    main: { defaultTier: "HOT" as const, autoCapture: true, autoInject: true },
    cron: { defaultTier: "COLD" as const, autoCapture: false, autoInject: true },
    spawned: { defaultTier: "WARM" as const, autoCapture: false, autoInject: true },
  },
  tuning: {
    enabled: true,
    mode: "hybrid" as const,
    autoAdjust: {
      importanceThreshold: { min: 0.1, max: 0.9, step: 0.05 },
      hotTargetSize: { min: 10, max: 50 },
      warmTargetSize: { min: 50, max: 200 },
    },
    lockDurationDays: 7,
  },
  reporting: {
    enabled: true,
    channel: "log" as const,
    frequency: "on-change" as const,
    includeMetrics: true,
  },
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
      archive: (autoRecall.budgets as { archive?: number } | undefined)?.archive ?? injection.budgets.archive,
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
      archive: config.injection?.budgets?.archive ?? DEFAULTS.injection.budgets.archive,
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
      default: {
        hotTTL: config.decay?.default?.hotTTL ?? DEFAULTS.decay.default.hotTTL,
        warmTTL: config.decay?.default?.warmTTL ?? DEFAULTS.decay.default.warmTTL,
        coldTTL: config.decay?.default?.coldTTL ?? DEFAULTS.decay.default.coldTTL,
      },
      overrides: (config.decay?.overrides ?? {}) as Record<
        MemoryTypeValue,
        { hotTTL: string | number | null; warmTTL: string | number | null; coldTTL?: string | number | null }
      >,
    },
    profiles: {
      retrieval: {
        profile: config.profiles?.retrieval?.profile ?? DEFAULTS.profiles.retrieval.profile,
        profiles: config.profiles?.retrieval?.profiles as Record<string, { hot: number; warm: number; cold: number; archive: number }> | undefined,
      },
      decay: {
        profile: config.profiles?.decay?.profile ?? DEFAULTS.profiles.decay.profile,
        profiles: config.profiles?.decay?.profiles as Record<string, { hotTtl: string | number; warmTtl: string | number; coldTtl: string | number }> | undefined,
      },
      promotion: {
        profile: config.profiles?.promotion?.profile ?? DEFAULTS.profiles.promotion.profile,
        profiles: config.profiles?.promotion?.profiles as Record<string, { uses: number; days: number }> | undefined,
      },
      agents: (config.profiles?.agents ?? {}) as Record<string, { retrieval?: string; decay?: string; promotion?: string }>,
    },
    context: {
      ttlHours: config.context?.ttlHours ?? DEFAULTS.context.ttlHours,
    },
    sessions: {
      main: {
        defaultTier: config.sessions?.main?.defaultTier ?? DEFAULTS.sessions.main.defaultTier,
        autoCapture: config.sessions?.main?.autoCapture ?? DEFAULTS.sessions.main.autoCapture,
        autoInject: config.sessions?.main?.autoInject ?? DEFAULTS.sessions.main.autoInject,
      },
      cron: {
        defaultTier: config.sessions?.cron?.defaultTier ?? DEFAULTS.sessions.cron.defaultTier,
        autoCapture: config.sessions?.cron?.autoCapture ?? DEFAULTS.sessions.cron.autoCapture,
        autoInject: config.sessions?.cron?.autoInject ?? DEFAULTS.sessions.cron.autoInject,
      },
      spawned: {
        defaultTier: config.sessions?.spawned?.defaultTier ?? DEFAULTS.sessions.spawned.defaultTier,
        autoCapture: config.sessions?.spawned?.autoCapture ?? DEFAULTS.sessions.spawned.autoCapture,
        autoInject: config.sessions?.spawned?.autoInject ?? DEFAULTS.sessions.spawned.autoInject,
      },
    },
    tuning: {
      enabled: config.tuning?.enabled ?? DEFAULTS.tuning.enabled,
      mode: config.tuning?.mode ?? DEFAULTS.tuning.mode,
      autoAdjust: {
        importanceThreshold: {
          min: config.tuning?.autoAdjust?.importanceThreshold?.min ?? DEFAULTS.tuning.autoAdjust.importanceThreshold.min,
          max: config.tuning?.autoAdjust?.importanceThreshold?.max ?? DEFAULTS.tuning.autoAdjust.importanceThreshold.max,
          step: config.tuning?.autoAdjust?.importanceThreshold?.step ?? DEFAULTS.tuning.autoAdjust.importanceThreshold.step,
        },
        hotTargetSize: {
          min: config.tuning?.autoAdjust?.hotTargetSize?.min ?? DEFAULTS.tuning.autoAdjust.hotTargetSize.min,
          max: config.tuning?.autoAdjust?.hotTargetSize?.max ?? DEFAULTS.tuning.autoAdjust.hotTargetSize.max,
        },
        warmTargetSize: {
          min: config.tuning?.autoAdjust?.warmTargetSize?.min ?? DEFAULTS.tuning.autoAdjust.warmTargetSize.min,
          max: config.tuning?.autoAdjust?.warmTargetSize?.max ?? DEFAULTS.tuning.autoAdjust.warmTargetSize.max,
        },
      },
      lockDurationDays: config.tuning?.lockDurationDays ?? DEFAULTS.tuning.lockDurationDays,
    },
    reporting: {
      enabled: config.reporting?.enabled ?? DEFAULTS.reporting.enabled,
      channel: config.reporting?.channel ?? DEFAULTS.reporting.channel,
      frequency: config.reporting?.frequency ?? DEFAULTS.reporting.frequency,
      includeMetrics: config.reporting?.includeMetrics ?? DEFAULTS.reporting.includeMetrics,
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
    description: "Configure the background decay service and per-type TTLs",
    fields: {
      intervalHours: {
        label: "Interval (hours)",
        description: "Hours between decay runs",
        type: "number",
        min: 1,
        placeholder: "6",
      },
      default: {
        label: "Default TTLs",
        description: "Fallback TTL values when no override exists for a memory type",
        fields: {
          hotTTL: {
            label: "Hot TTL (hours)",
            description: "Hours before HOT memories demote to COLD",
            type: "number",
            min: 1,
            placeholder: "72",
          },
          warmTTL: {
            label: "Warm TTL (days)",
            description: "Days of inactivity before WARM memories demote to COLD",
            type: "number",
            min: 1,
            placeholder: "60",
          },
        },
      },
      overrides: {
        label: "Per-Type Overrides",
        description: "Override TTLs for specific memory types (null = never demote)",
        type: "object",
        fields: {
          factual: {
            label: "Factual Memories",
            description: "TTL overrides for factual memories (facts, data)",
            fields: {
              hotTTL: {
                label: "Hot TTL (hours)",
                description: "Hours before HOT demotes (null = never)",
                type: "number",
                nullable: true,
                min: 1,
              },
              warmTTL: {
                label: "Warm TTL (days)",
                description: "Days before WARM demotes (null = never)",
                type: "number",
                nullable: true,
                min: 1,
              },
            },
          },
          procedural: {
            label: "Procedural Memories",
            description: "TTL overrides for procedural memories (how-to knowledge)",
            fields: {
              hotTTL: {
                label: "Hot TTL (hours)",
                description: "Hours before HOT demotes (null = never)",
                type: "number",
                nullable: true,
                min: 1,
              },
              warmTTL: {
                label: "Warm TTL (days)",
                description: "Days before WARM demotes (null = never)",
                type: "number",
                nullable: true,
                min: 1,
              },
            },
          },
          episodic: {
            label: "Episodic Memories",
            description: "TTL overrides for episodic memories (conversation/event)",
            fields: {
              hotTTL: {
                label: "Hot TTL (hours)",
                description: "Hours before HOT demotes (null = never)",
                type: "number",
                nullable: true,
                min: 1,
              },
              warmTTL: {
                label: "Warm TTL (days)",
                description: "Days before WARM demotes (null = never)",
                type: "number",
                nullable: true,
                min: 1,
              },
            },
          },
          project: {
            label: "Project Memories",
            description: "TTL overrides for project-specific context",
            fields: {
              hotTTL: {
                label: "Hot TTL (hours)",
                description: "Hours before HOT demotes (null = never)",
                type: "number",
                nullable: true,
                min: 1,
              },
              warmTTL: {
                label: "Warm TTL (days)",
                description: "Days before WARM demotes (null = never)",
                type: "number",
                nullable: true,
                min: 1,
              },
            },
          },
        },
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
  sessions: {
    label: "Session Settings",
    description: "Configure per-session-type behavior for main, cron, and spawned sessions",
    fields: {
      main: {
        label: "Main Sessions",
        description: "Settings for interactive (main) sessions",
        fields: {
          defaultTier: {
            label: "Default Tier",
            description: "Default tier for memories captured in main sessions",
            type: "select",
            options: [
              { value: "HOT", label: "HOT" },
              { value: "WARM", label: "WARM" },
              { value: "COLD", label: "COLD" },
              { value: "ARCHIVE", label: "ARCHIVE" },
            ],
          },
          autoCapture: {
            label: "Auto-Capture",
            description: "Automatically capture memories in main sessions",
            type: "toggle",
          },
          autoInject: {
            label: "Auto-Inject",
            description: "Automatically inject memories into main sessions",
            type: "toggle",
          },
        },
      },
      cron: {
        label: "Cron Sessions",
        description: "Settings for scheduled (cron) sessions",
        fields: {
          defaultTier: {
            label: "Default Tier",
            description: "Default tier for memories captured in cron sessions",
            type: "select",
            options: [
              { value: "HOT", label: "HOT" },
              { value: "WARM", label: "WARM" },
              { value: "COLD", label: "COLD" },
              { value: "ARCHIVE", label: "ARCHIVE" },
            ],
          },
          autoCapture: {
            label: "Auto-Capture",
            description: "Automatically capture memories in cron sessions",
            type: "toggle",
          },
          autoInject: {
            label: "Auto-Inject",
            description: "Automatically inject memories into cron sessions",
            type: "toggle",
          },
        },
      },
      spawned: {
        label: "Spawned Sessions",
        description: "Settings for child (spawned) sessions",
        fields: {
          defaultTier: {
            label: "Default Tier",
            description: "Default tier for memories captured in spawned sessions",
            type: "select",
            options: [
              { value: "HOT", label: "HOT" },
              { value: "WARM", label: "WARM" },
              { value: "COLD", label: "COLD" },
              { value: "ARCHIVE", label: "ARCHIVE" },
            ],
          },
          autoCapture: {
            label: "Auto-Capture",
            description: "Automatically capture memories in spawned sessions",
            type: "toggle",
          },
          autoInject: {
            label: "Auto-Inject",
            description: "Automatically inject memories into spawned sessions",
            type: "toggle",
          },
        },
      },
    },
  },
  tuning: {
    label: "Tuning Settings",
    description: "Configure auto-adjustment behavior for memory tier management",
    fields: {
      enabled: {
        label: "Enabled",
        description: "Whether tuning is enabled",
        type: "toggle",
      },
      mode: {
        label: "Mode",
        description: "Tuning mode: auto (fully automatic), manual (user only), hybrid (auto with user locks)",
        type: "select",
        options: [
          { value: "auto", label: "Auto (fully automatic)" },
          { value: "manual", label: "Manual (user only)" },
          { value: "hybrid", label: "Hybrid (auto with user locks)" },
        ],
      },
      autoAdjust: {
        label: "Auto-Adjust Settings",
        description: "Parameter bounds and target sizes for automatic adjustment",
        fields: {
          importanceThreshold: {
            label: "Importance Threshold Bounds",
            description: "Bounds for the importance threshold parameter",
            fields: {
              min: {
                label: "Minimum",
                description: "Minimum allowed value for importance threshold",
                type: "slider",
                min: 0,
                max: 1,
                step: 0.05,
              },
              max: {
                label: "Maximum",
                description: "Maximum allowed value for importance threshold",
                type: "slider",
                min: 0,
                max: 1,
                step: 0.05,
              },
              step: {
                label: "Step",
                description: "Adjustment step size",
                type: "slider",
                min: 0.01,
                max: 0.2,
                step: 0.01,
              },
            },
          },
          hotTargetSize: {
            label: "HOT Tier Target Size",
            description: "Target size range for HOT tier",
            fields: {
              min: {
                label: "Minimum",
                description: "Minimum target size for HOT tier",
                type: "number",
                min: 0,
              },
              max: {
                label: "Maximum",
                description: "Maximum target size for HOT tier",
                type: "number",
                min: 0,
              },
            },
          },
          warmTargetSize: {
            label: "WARM Tier Target Size",
            description: "Target size range for WARM tier",
            fields: {
              min: {
                label: "Minimum",
                description: "Minimum target size for WARM tier",
                type: "number",
                min: 0,
              },
              max: {
                label: "Maximum",
                description: "Maximum target size for WARM tier",
                type: "number",
                min: 0,
              },
            },
          },
        },
      },
      lockDurationDays: {
        label: "Lock Duration (days)",
        description: "Days to lock a parameter after user override",
        type: "number",
        min: 1,
        placeholder: "7",
      },
    },
  },
  reporting: {
    label: "Reporting Settings",
    description: "Configure notifications when TRAM auto-tunes parameters",
    fields: {
      enabled: {
        label: "Enabled",
        description: "Whether reporting is enabled",
        type: "toggle",
      },
      channel: {
        label: "Channel",
        description: "Notification channel for tuning reports",
        type: "select",
        options: [
          { value: "log", label: "Log File" },
          { value: "telegram", label: "Telegram" },
          { value: "discord", label: "Discord" },
          { value: "slack", label: "Slack" },
          { value: "none", label: "None (disabled)" },
        ],
      },
      frequency: {
        label: "Frequency",
        description: "How often to send notifications",
        type: "select",
        options: [
          { value: "on-change", label: "On Change (immediate)" },
          { value: "daily-summary", label: "Daily Summary" },
          { value: "weekly-summary", label: "Weekly Summary" },
        ],
      },
      includeMetrics: {
        label: "Include Metrics",
        description: "Include detailed metrics in notifications",
        type: "toggle",
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
