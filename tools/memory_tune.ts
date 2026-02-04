/**
 * memory_tune tool - Runtime profile switching for TRAM memory system.
 *
 * Allows adjusting retrieval, decay, and promotion profiles at runtime
 * with optional persistence to config file.
 *
 * Scope behavior:
 * - session: This session only (default, no persistence)
 * - agent: Write to `tram.profiles.agents.<agentId>` (persisted)
 * - global: Write to root defaults (persisted)
 *
 * Resolution order (highest to lowest priority):
 * 1. Session runtime override (memory_tune without persist)
 * 2. Agent-specific config (`tram.profiles.agents.<agentId>`)
 * 3. Global default (`tram.profiles.*.profile`)
 * 4. Built-in default (focused/thorough/selective)
 */

import type { Database as SqliteDb } from "better-sqlite3";
import type { ResolvedConfig, AgentProfiles } from "../config.js";
import {
  RETRIEVAL_PROFILES,
  DECAY_PROFILES,
  PROMOTION_PROFILES,
  getRetrievalProfile,
  getDecayProfile,
  getPromotionProfile,
  type RetrievalProfile,
  type DecayProfile,
  type PromotionProfile,
  type ProfileSource,
} from "../core/profiles.js";

/**
 * Input parameters for memory_tune tool
 */
export interface MemoryTuneInput {
  /** Retrieval profile name to apply */
  retrieval?: string;
  /** Decay profile name to apply */
  decay?: string;
  /** Promotion profile name to apply */
  promotion?: string;
  /** Whether to persist to config file */
  persist?: boolean;
  /** Scope for persistence: session (default), agent, or global */
  scope?: "session" | "agent" | "global";
}

/**
 * Profile info with source attribution
 */
interface ProfileInfo<T> {
  profile: string;
  values: T;
  source: ProfileSource;
}

/**
 * Result from memory_tune tool
 */
export interface MemoryTuneResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    retrieval: ProfileInfo<RetrievalProfile>;
    decay: ProfileInfo<DecayProfile>;
    promotion: ProfileInfo<PromotionProfile>;
    agentId: string;
    persisted: boolean;
    changes: string[];
    warnings: string[];
  };
}

/**
 * Session runtime overrides (in-memory, not persisted)
 */
let sessionOverrides: AgentProfiles = {};

/**
 * Current agent ID (detected from session context)
 */
let currentAgentId: string = "main";

/**
 * MemoryTuneTool handles runtime profile switching for TRAM.
 */
export class MemoryTuneTool {
  private db: SqliteDb;
  private config: ResolvedConfig;

  constructor(db: SqliteDb, config: ResolvedConfig) {
    this.db = db;
    this.config = config;
  }

  /**
   * Set the current agent ID for profile resolution.
   * @param agentId - The agent ID (e.g., "main", "cron", "spawn:label")
   */
  static setAgentId(agentId: string): void {
    currentAgentId = agentId;
  }

  /**
   * Get the current agent ID.
   */
  static getAgentId(): string {
    return currentAgentId;
  }

  /**
   * Clear session overrides (useful for testing).
   */
  static clearSessionOverrides(): void {
    sessionOverrides = {};
  }

  /**
   * Get current session overrides.
   */
  static getSessionOverrides(): AgentProfiles {
    return { ...sessionOverrides };
  }

  /**
   * Execute the memory_tune tool.
   *
   * @param params - Tool parameters
   * @returns Result with current/new profile settings
   */
  async execute(params: MemoryTuneInput): Promise<MemoryTuneResult> {
    const changes: string[] = [];
    const persist = params.persist ?? false;
    const scope = params.scope ?? "session";

    // Validate profile names if provided
    if (params.retrieval) {
      const profile = this.resolveRetrievalProfile(params.retrieval);
      if (!profile) {
        return this.errorResult(`Unknown retrieval profile: ${params.retrieval}. ` +
          `Available: ${this.getAvailableRetrievalProfiles().join(", ")}`);
      }
    }
    if (params.decay) {
      const profile = this.resolveDecayProfile(params.decay);
      if (!profile) {
        return this.errorResult(`Unknown decay profile: ${params.decay}. ` +
          `Available: ${this.getAvailableDecayProfiles().join(", ")}`);
      }
    }
    if (params.promotion) {
      const profile = this.resolvePromotionProfile(params.promotion);
      if (!profile) {
        return this.errorResult(`Unknown promotion profile: ${params.promotion}. ` +
          `Available: ${this.getAvailablePromotionProfiles().join(", ")}`);
      }
    }

    // Warnings (currently unused, kept for interface compatibility)
    const warnings: string[] = [];

    // Apply changes based on scope
    if (params.retrieval || params.decay || params.promotion) {
      // Decay and promotion require persist=true (they affect ALL memories system-wide)
      if (scope === "session" && (params.decay || params.promotion)) {
        const systemWide = [
          params.decay ? "decay" : null,
          params.promotion ? "promotion" : null,
        ].filter(Boolean).join(" and ");

        return this.errorResult(
          `Cannot set ${systemWide} in session scope. ` +
          `These profiles affect ALL memories system-wide and require persist=true.\n\n` +
          `Use: memory_tune({ ${params.decay ? `decay: "${params.decay}"` : ""}${params.decay && params.promotion ? ", " : ""}${params.promotion ? `promotion: "${params.promotion}"` : ""}, persist: true })\n\n` +
          `Retrieval profiles can use session scope (affects only what gets injected into context).`
        );
      }

      if (scope === "session") {
        // Session-only changes (in-memory) - only retrieval allowed here
        if (params.retrieval) {
          sessionOverrides.retrieval = params.retrieval;
          changes.push(`retrieval → ${params.retrieval} (session)`);
        }
      } else if (persist) {
        // Persistent changes require config file modification
        // For now, we store in the meta table as a workaround
        // Real implementation would write to the config file
        const persisted = this.persistToMeta(params, scope);
        if (persisted) {
          if (params.retrieval) {
            changes.push(`retrieval → ${params.retrieval} (${scope}, persisted)`);
          }
          if (params.decay) {
            changes.push(`decay → ${params.decay} (${scope}, persisted)`);
          }
          if (params.promotion) {
            changes.push(`promotion → ${params.promotion} (${scope}, persisted)`);
          }
        }
      } else {
        return this.errorResult(
          `Scope "${scope}" requires persist=true to save changes. ` +
          `Use scope="session" for non-persistent changes.`
        );
      }
    }

    // Resolve current effective profiles
    const retrieval = this.getCurrentRetrievalProfile();
    const decay = this.getCurrentDecayProfile();
    const promotion = this.getCurrentPromotionProfile();

    // Build response
    const details = {
      retrieval,
      decay,
      promotion,
      agentId: currentAgentId,
      persisted: persist && scope !== "session",
      changes,
      warnings,
    };

    // Format text response
    let text = "**Current Memory Profiles**\n\n";

    text += `**Retrieval:** ${retrieval.profile} (source: ${retrieval.source})\n`;
    text += `  HOT: ${retrieval.values.hot}%, WARM: ${retrieval.values.warm}%, `;
    text += `COLD: ${retrieval.values.cold}%, ARCHIVE: ${retrieval.values.archive}%\n\n`;

    text += `**Decay:** ${decay.profile} (source: ${decay.source})\n`;
    text += `  HOT→WARM: ${decay.values.hotTtl}, WARM→COLD: ${decay.values.warmTtl}, `;
    text += `COLD→ARCHIVE: ${decay.values.coldTtl}\n\n`;

    text += `**Promotion:** ${promotion.profile} (source: ${promotion.source})\n`;
    text += `  Uses: ${promotion.values.uses}, Days: ${promotion.values.days}\n\n`;

    text += `**Agent:** ${currentAgentId}\n`;

    if (changes.length > 0) {
      text += `\n**Changes Applied:**\n`;
      for (const change of changes) {
        text += `- ${change}\n`;
      }
    }

    if (warnings.length > 0) {
      text += `\n**Warnings:**\n`;
      for (const warning of warnings) {
        text += `${warning}\n\n`;
      }
    }

    text += `\n**Available Profiles:**\n`;
    text += `- Retrieval: ${this.getAvailableRetrievalProfiles().join(", ")}\n`;
    text += `- Decay: ${this.getAvailableDecayProfiles().join(", ")}\n`;
    text += `- Promotion: ${this.getAvailablePromotionProfiles().join(", ")}\n`;

    return {
      content: [{ type: "text", text }],
      details,
    };
  }

  /**
   * Get current effective retrieval profile with source tracking.
   */
  private getCurrentRetrievalProfile(): ProfileInfo<RetrievalProfile> {
    // 1. Session override
    if (sessionOverrides.retrieval) {
      const profile = this.resolveRetrievalProfile(sessionOverrides.retrieval);
      if (profile) {
        return { profile: sessionOverrides.retrieval, values: profile, source: "session" };
      }
    }

    // 2. Agent-specific config
    const agentConfig = this.config.profiles.agents[currentAgentId];
    if (agentConfig?.retrieval) {
      const profile = this.resolveRetrievalProfile(agentConfig.retrieval);
      if (profile) {
        return { profile: agentConfig.retrieval, values: profile, source: `agent:${currentAgentId}` };
      }
    }

    // 3. Global default
    if (this.config.profiles.retrieval.profile) {
      const profile = this.resolveRetrievalProfile(this.config.profiles.retrieval.profile);
      if (profile) {
        return { profile: this.config.profiles.retrieval.profile, values: profile, source: "global" };
      }
    }

    // 4. Built-in default
    return { profile: "focused", values: RETRIEVAL_PROFILES.focused, source: "builtin" };
  }

  /**
   * Get current effective decay profile with source tracking.
   */
  private getCurrentDecayProfile(): ProfileInfo<DecayProfile> {
    // 1. Session override
    if (sessionOverrides.decay) {
      const profile = this.resolveDecayProfile(sessionOverrides.decay);
      if (profile) {
        return { profile: sessionOverrides.decay, values: profile, source: "session" };
      }
    }

    // 2. Agent-specific config
    const agentConfig = this.config.profiles.agents[currentAgentId];
    if (agentConfig?.decay) {
      const profile = this.resolveDecayProfile(agentConfig.decay);
      if (profile) {
        return { profile: agentConfig.decay, values: profile, source: `agent:${currentAgentId}` };
      }
    }

    // 3. Global default
    if (this.config.profiles.decay.profile) {
      const profile = this.resolveDecayProfile(this.config.profiles.decay.profile);
      if (profile) {
        return { profile: this.config.profiles.decay.profile, values: profile, source: "global" };
      }
    }

    // 4. Built-in default
    return { profile: "thorough", values: DECAY_PROFILES.thorough, source: "builtin" };
  }

  /**
   * Get current effective promotion profile with source tracking.
   */
  private getCurrentPromotionProfile(): ProfileInfo<PromotionProfile> {
    // 1. Session override
    if (sessionOverrides.promotion) {
      const profile = this.resolvePromotionProfile(sessionOverrides.promotion);
      if (profile) {
        return { profile: sessionOverrides.promotion, values: profile, source: "session" };
      }
    }

    // 2. Agent-specific config
    const agentConfig = this.config.profiles.agents[currentAgentId];
    if (agentConfig?.promotion) {
      const profile = this.resolvePromotionProfile(agentConfig.promotion);
      if (profile) {
        return { profile: agentConfig.promotion, values: profile, source: `agent:${currentAgentId}` };
      }
    }

    // 3. Global default
    if (this.config.profiles.promotion.profile) {
      const profile = this.resolvePromotionProfile(this.config.profiles.promotion.profile);
      if (profile) {
        return { profile: this.config.profiles.promotion.profile, values: profile, source: "global" };
      }
    }

    // 4. Built-in default
    return { profile: "selective", values: PROMOTION_PROFILES.selective, source: "builtin" };
  }

  /**
   * Resolve retrieval profile by name (checking custom profiles first).
   */
  private resolveRetrievalProfile(name: string): RetrievalProfile | undefined {
    return getRetrievalProfile(name, this.config.profiles.retrieval.profiles);
  }

  /**
   * Resolve decay profile by name (checking custom profiles first).
   */
  private resolveDecayProfile(name: string): DecayProfile | undefined {
    return getDecayProfile(name, this.config.profiles.decay.profiles);
  }

  /**
   * Resolve promotion profile by name (checking custom profiles first).
   */
  private resolvePromotionProfile(name: string): PromotionProfile | undefined {
    return getPromotionProfile(name, this.config.profiles.promotion.profiles);
  }

  /**
   * Get list of available retrieval profile names.
   */
  private getAvailableRetrievalProfiles(): string[] {
    const builtIn = Object.keys(RETRIEVAL_PROFILES);
    const custom = this.config.profiles.retrieval.profiles
      ? Object.keys(this.config.profiles.retrieval.profiles)
      : [];
    return [...new Set([...builtIn, ...custom])].sort();
  }

  /**
   * Get list of available decay profile names.
   */
  private getAvailableDecayProfiles(): string[] {
    const builtIn = Object.keys(DECAY_PROFILES);
    const custom = this.config.profiles.decay.profiles
      ? Object.keys(this.config.profiles.decay.profiles)
      : [];
    return [...new Set([...builtIn, ...custom])].sort();
  }

  /**
   * Get list of available promotion profile names.
   */
  private getAvailablePromotionProfiles(): string[] {
    const builtIn = Object.keys(PROMOTION_PROFILES);
    const custom = this.config.profiles.promotion.profiles
      ? Object.keys(this.config.profiles.promotion.profiles)
      : [];
    return [...new Set([...builtIn, ...custom])].sort();
  }

  /**
   * Persist profile settings to the meta table.
   * This is a workaround since we can't modify config files directly.
   */
  private persistToMeta(params: MemoryTuneInput, scope: "agent" | "global"): boolean {
    try {
      const key = scope === "agent" ? `profile_agent_${currentAgentId}` : "profile_global";
      const now = new Date().toISOString();

      // Get existing data
      const existing = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
      let data: AgentProfiles = {};
      if (existing) {
        try {
          data = JSON.parse(existing.value);
        } catch {
          data = {};
        }
      }

      // Merge new settings
      if (params.retrieval) data.retrieval = params.retrieval;
      if (params.decay) data.decay = params.decay;
      if (params.promotion) data.promotion = params.promotion;

      // Save
      this.db.prepare(`
        INSERT OR REPLACE INTO meta (key, value, updated_at)
        VALUES (?, ?, ?)
      `).run(key, JSON.stringify(data), now);

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create error result.
   */
  private errorResult(message: string): MemoryTuneResult {
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      details: {
        retrieval: { profile: "focused", values: RETRIEVAL_PROFILES.focused, source: "builtin" },
        decay: { profile: "thorough", values: DECAY_PROFILES.thorough, source: "builtin" },
        promotion: { profile: "selective", values: PROMOTION_PROFILES.selective, source: "builtin" },
        agentId: currentAgentId,
        persisted: false,
        changes: [],
        warnings: [],
      },
    };
  }
}

export default MemoryTuneTool;
