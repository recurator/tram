/**
 * Duration parser utility for TRAM configuration.
 *
 * Supports both duration strings (e.g., "5m", "1h", "7d", "4h30m")
 * and numeric values for backwards compatibility.
 *
 * Duration string format:
 *   - s: seconds (e.g., "30s")
 *   - m: minutes (e.g., "5m", "30m")
 *   - h: hours (e.g., "1h", "4h30m")
 *   - d: days (e.g., "7d", "30d")
 *
 * Numeric values are interpreted based on context:
 *   - For hotTTL: as hours (backwards compatible)
 *   - For warmTTL/coldTTL: as days (backwards compatible)
 */

/**
 * Duration units in milliseconds
 */
const UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * Parse a duration string or number into milliseconds.
 *
 * @param duration - Duration string (e.g., "5m", "1h", "7d") or number
 * @param defaultUnit - Unit to use for bare numbers: "h" for hours, "d" for days (default: "h")
 * @returns Duration in milliseconds
 * @throws Error if the duration string is invalid
 *
 * @example
 * ```typescript
 * parseDuration("5m")        // 300000 (5 minutes)
 * parseDuration("1h")        // 3600000 (1 hour)
 * parseDuration("7d")        // 604800000 (7 days)
 * parseDuration("4h30m")     // 16200000 (4 hours 30 minutes)
 * parseDuration(72, "h")     // 259200000 (72 hours)
 * parseDuration(60, "d")     // 5184000000 (60 days)
 * ```
 */
export function parseDuration(
  duration: string | number,
  defaultUnit: "s" | "m" | "h" | "d" = "h"
): number {
  // Handle numeric input (backwards compatibility)
  if (typeof duration === "number") {
    if (duration < 0) {
      throw new Error(`Duration cannot be negative: ${duration}`);
    }
    return duration * UNITS[defaultUnit];
  }

  // Handle string input
  const trimmed = duration.trim().toLowerCase();
  if (!trimmed) {
    throw new Error("Duration string cannot be empty");
  }

  // Check for bare number (no unit)
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const value = parseFloat(trimmed);
    return value * UNITS[defaultUnit];
  }

  // Parse compound duration (e.g., "4h30m")
  let totalMs = 0;
  const regex = /(\d+(?:\.\d+)?)\s*([smhd])/g;
  let match: RegExpExecArray | null;
  let hasMatch = false;

  while ((match = regex.exec(trimmed)) !== null) {
    hasMatch = true;
    const value = parseFloat(match[1]);
    const unit = match[2];
    totalMs += value * UNITS[unit];
  }

  if (!hasMatch) {
    throw new Error(
      `Invalid duration format: "${duration}". Expected format like "5m", "1h", "7d", or "4h30m"`
    );
  }

  return totalMs;
}

/**
 * Format milliseconds into a human-readable duration string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string (e.g., "4h 30m", "7d", "1h 15m 30s")
 *
 * @example
 * ```typescript
 * formatDuration(300000)     // "5m"
 * formatDuration(3600000)    // "1h"
 * formatDuration(604800000)  // "7d"
 * formatDuration(16200000)   // "4h 30m"
 * ```
 */
export function formatDuration(ms: number): string {
  if (ms < 0) {
    throw new Error(`Duration cannot be negative: ${ms}`);
  }

  if (ms === 0) {
    return "0s";
  }

  const parts: string[] = [];

  // Days
  const days = Math.floor(ms / UNITS.d);
  if (days > 0) {
    parts.push(`${days}d`);
    ms %= UNITS.d;
  }

  // Hours
  const hours = Math.floor(ms / UNITS.h);
  if (hours > 0) {
    parts.push(`${hours}h`);
    ms %= UNITS.h;
  }

  // Minutes
  const minutes = Math.floor(ms / UNITS.m);
  if (minutes > 0) {
    parts.push(`${minutes}m`);
    ms %= UNITS.m;
  }

  // Seconds
  const seconds = Math.floor(ms / UNITS.s);
  if (seconds > 0) {
    parts.push(`${seconds}s`);
  }

  return parts.join(" ");
}

/**
 * Convert a duration to hours (for backwards compatibility).
 *
 * @param duration - Duration string or number
 * @param defaultUnit - Unit for bare numbers (default: "h")
 * @returns Duration in hours
 */
export function toHours(
  duration: string | number,
  defaultUnit: "s" | "m" | "h" | "d" = "h"
): number {
  const ms = parseDuration(duration, defaultUnit);
  return ms / UNITS.h;
}

/**
 * Convert a duration to days (for backwards compatibility).
 *
 * @param duration - Duration string or number
 * @param defaultUnit - Unit for bare numbers (default: "d")
 * @returns Duration in days
 */
export function toDays(
  duration: string | number,
  defaultUnit: "s" | "m" | "h" | "d" = "d"
): number {
  const ms = parseDuration(duration, defaultUnit);
  return ms / UNITS.d;
}

/**
 * Check if a value is a valid duration (string or positive number).
 *
 * @param value - Value to check
 * @returns True if valid duration format
 */
export function isValidDuration(value: unknown): value is string | number {
  if (typeof value === "number") {
    return value >= 0 && Number.isFinite(value);
  }

  if (typeof value === "string") {
    try {
      parseDuration(value);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}
