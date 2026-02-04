/**
 * Profile Presets for TRAM Memory System
 *
 * Defines preset configurations for:
 * - Retrieval: How memory budgets are allocated across tiers
 * - Decay: How quickly memories transition between tiers
 * - Promotion: Requirements for upgrading memories to higher tiers
 *
 * Profiles can be customized at runtime via memory_tune tool.
 */

/**
 * Retrieval profile - budget allocation percentages across tiers
 */
export interface RetrievalProfile {
  /** Percentage budget for HOT tier (0-100) */
  hot: number;
  /** Percentage budget for WARM tier (0-100) */
  warm: number;
  /** Percentage budget for COLD tier (0-100) */
  cold: number;
  /** Percentage budget for ARCHIVE tier (0-100) */
  archive: number;
}

/**
 * Decay profile - TTLs for tier transitions
 */
export interface DecayProfile {
  /** Duration before HOT→WARM transition (e.g., "1h", "7d", or number in hours) */
  hotTtl: string | number;
  /** Duration before WARM→COLD transition (e.g., "4h", "30d", or number in days) */
  warmTtl: string | number;
  /** Duration before COLD→ARCHIVE transition (e.g., "24h", "180d", or number in days) */
  coldTtl: string | number;
}

/**
 * Promotion profile - thresholds for tier upgrades
 */
export interface PromotionProfile {
  /** Minimum use count for promotion */
  uses: number;
  /** Minimum distinct days of use for promotion */
  days: number;
}

/**
 * Built-in retrieval profiles
 *
 * - narrow: Focus on most relevant (HOT)
 * - focused: Balance recent over archive (default)
 * - balanced: Equal consideration across tiers
 * - broad: Include older memories
 * - expansive: Prioritize historical context
 */
export const RETRIEVAL_PROFILES: Record<string, RetrievalProfile> = {
  narrow: { hot: 70, warm: 20, cold: 10, archive: 0 },
  focused: { hot: 50, warm: 30, cold: 15, archive: 5 },
  balanced: { hot: 30, warm: 30, cold: 30, archive: 10 },
  broad: { hot: 5, warm: 25, cold: 25, archive: 45 },
  expansive: { hot: 0, warm: 5, cold: 15, archive: 80 },
};

/**
 * Built-in decay profiles
 *
 * - forgetful: Rapid decay, quick turnover
 * - casual: Moderate decay for light usage
 * - attentive: Standard decay (default)
 * - thorough: Slow decay, long retention
 * - retentive: Very slow decay, extensive history
 */
export const DECAY_PROFILES: Record<string, DecayProfile> = {
  forgetful: { hotTtl: "5m", warmTtl: "15m", coldTtl: "1h" },
  casual: { hotTtl: "15m", warmTtl: "1h", coldTtl: "4h" },
  attentive: { hotTtl: "1h", warmTtl: "4h", coldTtl: "24h" },
  thorough: { hotTtl: "1d", warmTtl: "7d", coldTtl: "30d" },
  retentive: { hotTtl: "7d", warmTtl: "60d", coldTtl: "180d" },
};

/**
 * Built-in promotion profiles
 *
 * - forgiving: Easy promotion (minimal requirements)
 * - fair: Balanced requirements
 * - selective: Moderate requirements (default)
 * - demanding: Strict requirements
 * - ruthless: Very strict requirements
 */
export const PROMOTION_PROFILES: Record<string, PromotionProfile> = {
  forgiving: { uses: 1, days: 1 },
  fair: { uses: 2, days: 2 },
  selective: { uses: 3, days: 2 },
  demanding: { uses: 5, days: 3 },
  ruthless: { uses: 10, days: 5 },
};

/**
 * Source of a profile setting for tracking resolution order
 */
export type ProfileSource =
  | "session" // Runtime override (memory_tune without persist)
  | `agent:${string}` // Agent-specific config
  | "global" // Root-level config default
  | "builtin"; // Built-in default

/**
 * Resolved profile with source attribution
 */
export interface ResolvedProfileInfo<T> {
  /** The resolved profile name */
  profile: string;
  /** The actual profile values */
  values: T;
  /** Where this profile was resolved from */
  source: ProfileSource;
}

/**
 * Agent-specific profile overrides
 */
export interface AgentProfiles {
  retrieval?: string;
  decay?: string;
  promotion?: string;
}

/**
 * Profile resolution context
 */
export interface ProfileContext {
  /** Session-level overrides (highest priority) */
  sessionOverrides?: AgentProfiles;
  /** Agent-specific config from tram.agents.<agentId> */
  agentConfig?: AgentProfiles;
  /** Global defaults from tram config */
  globalDefaults?: {
    retrieval?: string;
    decay?: string;
    promotion?: string;
  };
  /** Custom profile definitions */
  customProfiles?: {
    retrieval?: Record<string, RetrievalProfile>;
    decay?: Record<string, DecayProfile>;
    promotion?: Record<string, PromotionProfile>;
  };
}

/**
 * Resolve a retrieval profile by name.
 *
 * @param name - Profile name
 * @param customProfiles - Custom profile definitions
 * @returns The retrieval profile values, or undefined if not found
 */
export function getRetrievalProfile(
  name: string,
  customProfiles?: Record<string, RetrievalProfile>
): RetrievalProfile | undefined {
  // Check custom profiles first
  if (customProfiles?.[name]) {
    return customProfiles[name];
  }
  // Fall back to built-in
  return RETRIEVAL_PROFILES[name];
}

/**
 * Resolve a decay profile by name.
 *
 * @param name - Profile name
 * @param customProfiles - Custom profile definitions
 * @returns The decay profile values, or undefined if not found
 */
export function getDecayProfile(
  name: string,
  customProfiles?: Record<string, DecayProfile>
): DecayProfile | undefined {
  // Check custom profiles first
  if (customProfiles?.[name]) {
    return customProfiles[name];
  }
  // Fall back to built-in
  return DECAY_PROFILES[name];
}

/**
 * Resolve a promotion profile by name.
 *
 * @param name - Profile name
 * @param customProfiles - Custom profile definitions
 * @returns The promotion profile values, or undefined if not found
 */
export function getPromotionProfile(
  name: string,
  customProfiles?: Record<string, PromotionProfile>
): PromotionProfile | undefined {
  // Check custom profiles first
  if (customProfiles?.[name]) {
    return customProfiles[name];
  }
  // Fall back to built-in
  return PROMOTION_PROFILES[name];
}

/**
 * Resolve retrieval profile with full source tracking.
 *
 * Resolution order (highest to lowest priority):
 * 1. Session runtime override
 * 2. Agent-specific config
 * 3. Global default
 * 4. Built-in default ("focused")
 *
 * @param context - Profile resolution context
 * @returns Resolved profile with source attribution
 */
export function resolveRetrievalProfile(
  context: ProfileContext
): ResolvedProfileInfo<RetrievalProfile> {
  const customProfiles = context.customProfiles?.retrieval;

  // 1. Session override
  if (context.sessionOverrides?.retrieval) {
    const profile = getRetrievalProfile(
      context.sessionOverrides.retrieval,
      customProfiles
    );
    if (profile) {
      return {
        profile: context.sessionOverrides.retrieval,
        values: profile,
        source: "session",
      };
    }
  }

  // 2. Agent config
  if (context.agentConfig?.retrieval) {
    const profile = getRetrievalProfile(
      context.agentConfig.retrieval,
      customProfiles
    );
    if (profile) {
      return {
        profile: context.agentConfig.retrieval,
        values: profile,
        source: "agent:unknown", // Agent ID should be passed in context
      };
    }
  }

  // 3. Global default
  if (context.globalDefaults?.retrieval) {
    const profile = getRetrievalProfile(
      context.globalDefaults.retrieval,
      customProfiles
    );
    if (profile) {
      return {
        profile: context.globalDefaults.retrieval,
        values: profile,
        source: "global",
      };
    }
  }

  // 4. Built-in default
  return {
    profile: "focused",
    values: RETRIEVAL_PROFILES.focused,
    source: "builtin",
  };
}

/**
 * Resolve decay profile with full source tracking.
 *
 * @param context - Profile resolution context
 * @returns Resolved profile with source attribution
 */
export function resolveDecayProfile(
  context: ProfileContext
): ResolvedProfileInfo<DecayProfile> {
  const customProfiles = context.customProfiles?.decay;

  // 1. Session override
  if (context.sessionOverrides?.decay) {
    const profile = getDecayProfile(
      context.sessionOverrides.decay,
      customProfiles
    );
    if (profile) {
      return {
        profile: context.sessionOverrides.decay,
        values: profile,
        source: "session",
      };
    }
  }

  // 2. Agent config
  if (context.agentConfig?.decay) {
    const profile = getDecayProfile(context.agentConfig.decay, customProfiles);
    if (profile) {
      return {
        profile: context.agentConfig.decay,
        values: profile,
        source: "agent:unknown",
      };
    }
  }

  // 3. Global default
  if (context.globalDefaults?.decay) {
    const profile = getDecayProfile(
      context.globalDefaults.decay,
      customProfiles
    );
    if (profile) {
      return {
        profile: context.globalDefaults.decay,
        values: profile,
        source: "global",
      };
    }
  }

  // 4. Built-in default
  return {
    profile: "thorough",
    values: DECAY_PROFILES.thorough,
    source: "builtin",
  };
}

/**
 * Resolve promotion profile with full source tracking.
 *
 * @param context - Profile resolution context
 * @returns Resolved profile with source attribution
 */
export function resolvePromotionProfile(
  context: ProfileContext
): ResolvedProfileInfo<PromotionProfile> {
  const customProfiles = context.customProfiles?.promotion;

  // 1. Session override
  if (context.sessionOverrides?.promotion) {
    const profile = getPromotionProfile(
      context.sessionOverrides.promotion,
      customProfiles
    );
    if (profile) {
      return {
        profile: context.sessionOverrides.promotion,
        values: profile,
        source: "session",
      };
    }
  }

  // 2. Agent config
  if (context.agentConfig?.promotion) {
    const profile = getPromotionProfile(
      context.agentConfig.promotion,
      customProfiles
    );
    if (profile) {
      return {
        profile: context.agentConfig.promotion,
        values: profile,
        source: "agent:unknown",
      };
    }
  }

  // 3. Global default
  if (context.globalDefaults?.promotion) {
    const profile = getPromotionProfile(
      context.globalDefaults.promotion,
      customProfiles
    );
    if (profile) {
      return {
        profile: context.globalDefaults.promotion,
        values: profile,
        source: "global",
      };
    }
  }

  // 4. Built-in default
  return {
    profile: "selective",
    values: PROMOTION_PROFILES.selective,
    source: "builtin",
  };
}

/**
 * Get all available profile names for a category.
 *
 * @param category - Profile category
 * @param customProfiles - Custom profile definitions
 * @returns Array of available profile names
 */
export function getAvailableProfiles(
  category: "retrieval" | "decay" | "promotion",
  customProfiles?: ProfileContext["customProfiles"]
): string[] {
  const builtIn =
    category === "retrieval"
      ? Object.keys(RETRIEVAL_PROFILES)
      : category === "decay"
        ? Object.keys(DECAY_PROFILES)
        : Object.keys(PROMOTION_PROFILES);

  const custom = customProfiles?.[category]
    ? Object.keys(customProfiles[category] as Record<string, unknown>)
    : [];

  // Deduplicate and sort
  return [...new Set([...builtIn, ...custom])].sort();
}

/**
 * Validate that a profile name exists.
 *
 * @param category - Profile category
 * @param name - Profile name to validate
 * @param customProfiles - Custom profile definitions
 * @returns True if the profile exists
 */
export function isValidProfile(
  category: "retrieval" | "decay" | "promotion",
  name: string,
  customProfiles?: ProfileContext["customProfiles"]
): boolean {
  const available = getAvailableProfiles(category, customProfiles);
  return available.includes(name);
}
