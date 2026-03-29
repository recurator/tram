/**
 * Active Profile State - Shared state for the currently active decay profile.
 *
 * This module provides a bridge between MemoryTuneTool (which sets profiles)
 * and DecayEngine (which uses profile TTLs). It avoids circular dependencies
 * by keeping state in a separate module.
 *
 * Resolution order (highest to lowest priority):
 * 1. Session runtime override (set via memory_tune)
 * 2. Persisted profile from meta table (profile_global)
 * 3. Config default
 * 4. Built-in default ("thorough")
 */

import type { Database as SqliteDb } from "better-sqlite3";
import {
  DECAY_PROFILES,
  getDecayProfile,
  type DecayProfile,
  type ProfileSource,
} from "./profiles.js";
import type { ResolvedConfig } from "../config.js";

/**
 * Resolved decay profile with source attribution
 */
export interface ResolvedDecayProfile {
  profile: string;
  values: DecayProfile;
  source: ProfileSource;
}

/**
 * Session-level decay profile override (in-memory, not persisted)
 * This is updated by MemoryTuneTool when user calls memory_tune({ decay: "..." })
 */
let sessionDecayProfile: string | null = null;

/**
 * Current agent ID for profile resolution
 */
let currentAgentId: string = "main";

/**
 * Set the session-level decay profile override.
 * Called by MemoryTuneTool when user sets a session profile.
 */
export function setSessionDecayProfile(profile: string | null): void {
  sessionDecayProfile = profile;
}

/**
 * Get the current session decay profile override.
 */
export function getSessionDecayProfile(): string | null {
  return sessionDecayProfile;
}

/**
 * Clear session overrides.
 */
export function clearSessionDecayProfile(): void {
  sessionDecayProfile = null;
}

/**
 * Set the current agent ID.
 */
export function setCurrentAgentId(agentId: string): void {
  currentAgentId = agentId;
}

/**
 * Get the current agent ID.
 */
export function getCurrentAgentId(): string {
  return currentAgentId;
}

/**
 * Load persisted profile from meta table.
 * Checks both agent-specific and global profiles.
 */
function loadPersistedProfile(db: SqliteDb): string | null {
  try {
    // First check agent-specific profile
    const agentKey = `profile_agent_${currentAgentId}`;
    const agentRow = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(agentKey) as { value: string } | undefined;
    if (agentRow) {
      const data = JSON.parse(agentRow.value);
      if (data.decay) {
        return data.decay;
      }
    }

    // Then check global profile
    const globalRow = db.prepare(`SELECT value FROM meta WHERE key = ?`).get("profile_global") as { value: string } | undefined;
    if (globalRow) {
      const data = JSON.parse(globalRow.value);
      if (data.decay) {
        return data.decay;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the current effective decay profile.
 *
 * Resolution order:
 * 1. Session override (in-memory)
 * 2. Agent-specific persisted (meta table: profile_agent_<id>)
 * 3. Global persisted (meta table: profile_global)
 * 4. Config profiles.decay.profile
 * 5. Built-in default ("thorough")
 *
 * @param db - Database instance for reading persisted profiles
 * @param config - Resolved config for custom profiles and defaults
 * @returns Resolved profile with source attribution
 */
export function resolveActiveDecayProfile(
  db: SqliteDb,
  config: ResolvedConfig
): ResolvedDecayProfile {
  const customProfiles = config.profiles?.decay?.profiles;

  // 1. Session override (highest priority)
  if (sessionDecayProfile) {
    const profile = getDecayProfile(sessionDecayProfile, customProfiles);
    if (profile) {
      return {
        profile: sessionDecayProfile,
        values: profile,
        source: "session",
      };
    }
  }

  // 2. Persisted profile from meta table (agent or global)
  const persistedProfile = loadPersistedProfile(db);
  if (persistedProfile) {
    const profile = getDecayProfile(persistedProfile, customProfiles);
    if (profile) {
      // Determine source based on whether it was agent-specific or global
      const agentKey = `profile_agent_${currentAgentId}`;
      try {
        const agentRow = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(agentKey) as { value: string } | undefined;
        const source: ProfileSource = agentRow && JSON.parse(agentRow.value).decay === persistedProfile
          ? `agent:${currentAgentId}`
          : "global";
        return {
          profile: persistedProfile,
          values: profile,
          source,
        };
      } catch {
        return {
          profile: persistedProfile,
          values: profile,
          source: "global",
        };
      }
    }
  }

  // 3. Config profiles.decay.profile
  const configProfile = config.profiles?.decay?.profile;
  if (configProfile) {
    const profile = getDecayProfile(configProfile, customProfiles);
    if (profile) {
      return {
        profile: configProfile,
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
 * Get the active decay TTL values directly.
 * Convenience function for DecayEngine.
 */
export function getActiveDecayTTLs(
  db: SqliteDb,
  config: ResolvedConfig
): { hotTtl: string | number; warmTtl: string | number; coldTtl: string | number } {
  const resolved = resolveActiveDecayProfile(db, config);
  return resolved.values;
}
