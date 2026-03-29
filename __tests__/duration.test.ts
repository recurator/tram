/**
 * Unit tests for duration parser utility
 *
 * Tests parsing of duration strings and numbers:
 * - Duration strings: "5m", "1h", "7d", "4h30m"
 * - Numeric values (backwards compatible)
 * - Error handling for invalid inputs
 */

import { describe, it, expect } from "vitest";
import {
  parseDuration,
  formatDuration,
  toHours,
  toDays,
  isValidDuration,
} from "../utils/duration.js";

describe("parseDuration", () => {
  describe("string input", () => {
    it("should parse seconds", () => {
      expect(parseDuration("30s")).toBe(30 * 1000);
      expect(parseDuration("1s")).toBe(1000);
      expect(parseDuration("90s")).toBe(90 * 1000);
    });

    it("should parse minutes", () => {
      expect(parseDuration("5m")).toBe(5 * 60 * 1000);
      expect(parseDuration("30m")).toBe(30 * 60 * 1000);
      expect(parseDuration("1m")).toBe(60 * 1000);
    });

    it("should parse hours", () => {
      expect(parseDuration("1h")).toBe(60 * 60 * 1000);
      expect(parseDuration("24h")).toBe(24 * 60 * 60 * 1000);
      expect(parseDuration("72h")).toBe(72 * 60 * 60 * 1000);
    });

    it("should parse days", () => {
      expect(parseDuration("1d")).toBe(24 * 60 * 60 * 1000);
      expect(parseDuration("7d")).toBe(7 * 24 * 60 * 60 * 1000);
      expect(parseDuration("30d")).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it("should parse compound durations", () => {
      expect(parseDuration("4h30m")).toBe(4.5 * 60 * 60 * 1000);
      expect(parseDuration("1d12h")).toBe(36 * 60 * 60 * 1000);
      expect(parseDuration("1h30m15s")).toBe((90 * 60 + 15) * 1000);
    });

    it("should handle whitespace", () => {
      expect(parseDuration("  5m  ")).toBe(5 * 60 * 1000);
      expect(parseDuration("4h 30m")).toBe(4.5 * 60 * 60 * 1000);
    });

    it("should handle case insensitivity", () => {
      expect(parseDuration("5M")).toBe(5 * 60 * 1000);
      expect(parseDuration("1H")).toBe(60 * 60 * 1000);
      expect(parseDuration("7D")).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("should parse bare numbers with default unit", () => {
      // Default unit is hours
      expect(parseDuration("5")).toBe(5 * 60 * 60 * 1000);
      expect(parseDuration("72")).toBe(72 * 60 * 60 * 1000);
    });

    it("should respect defaultUnit parameter", () => {
      expect(parseDuration("5", "m")).toBe(5 * 60 * 1000);
      expect(parseDuration("60", "d")).toBe(60 * 24 * 60 * 60 * 1000);
      expect(parseDuration("30", "s")).toBe(30 * 1000);
    });

    it("should throw on empty string", () => {
      expect(() => parseDuration("")).toThrow("Duration string cannot be empty");
      expect(() => parseDuration("   ")).toThrow("Duration string cannot be empty");
    });

    it("should throw on invalid format", () => {
      expect(() => parseDuration("abc")).toThrow("Invalid duration format");
      expect(() => parseDuration("5x")).toThrow("Invalid duration format");
    });
  });

  describe("numeric input", () => {
    it("should handle numeric values with default unit (hours)", () => {
      expect(parseDuration(5, "h")).toBe(5 * 60 * 60 * 1000);
      expect(parseDuration(72, "h")).toBe(72 * 60 * 60 * 1000);
    });

    it("should handle numeric values with days unit", () => {
      expect(parseDuration(60, "d")).toBe(60 * 24 * 60 * 60 * 1000);
      expect(parseDuration(7, "d")).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("should handle decimal numbers", () => {
      expect(parseDuration(1.5, "h")).toBe(1.5 * 60 * 60 * 1000);
      expect(parseDuration(0.5, "d")).toBe(12 * 60 * 60 * 1000);
    });

    it("should throw on negative numbers", () => {
      expect(() => parseDuration(-5, "h")).toThrow("Duration cannot be negative");
    });

    it("should handle zero", () => {
      expect(parseDuration(0, "h")).toBe(0);
    });
  });
});

describe("formatDuration", () => {
  it("should format simple durations", () => {
    expect(formatDuration(5 * 60 * 1000)).toBe("5m");
    expect(formatDuration(60 * 60 * 1000)).toBe("1h");
    expect(formatDuration(24 * 60 * 60 * 1000)).toBe("1d");
  });

  it("should format compound durations", () => {
    expect(formatDuration(4.5 * 60 * 60 * 1000)).toBe("4h 30m");
    expect(formatDuration(36 * 60 * 60 * 1000)).toBe("1d 12h");
  });

  it("should handle zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("should throw on negative", () => {
    expect(() => formatDuration(-1000)).toThrow("Duration cannot be negative");
  });
});

describe("toHours", () => {
  it("should convert to hours", () => {
    expect(toHours("1h")).toBe(1);
    expect(toHours("30m")).toBe(0.5);
    expect(toHours("2d")).toBe(48);
    expect(toHours(72, "h")).toBe(72);
  });
});

describe("toDays", () => {
  it("should convert to days", () => {
    expect(toDays("1d")).toBe(1);
    expect(toDays("24h")).toBe(1);
    expect(toDays("7d")).toBe(7);
    expect(toDays(60, "d")).toBe(60);
  });
});

describe("isValidDuration", () => {
  it("should validate valid durations", () => {
    expect(isValidDuration("5m")).toBe(true);
    expect(isValidDuration("1h")).toBe(true);
    expect(isValidDuration(72)).toBe(true);
    expect(isValidDuration(0)).toBe(true);
  });

  it("should reject invalid durations", () => {
    expect(isValidDuration("abc")).toBe(false);
    expect(isValidDuration(-5)).toBe(false);
    expect(isValidDuration(null)).toBe(false);
    expect(isValidDuration(undefined)).toBe(false);
    expect(isValidDuration({})).toBe(false);
    expect(isValidDuration(NaN)).toBe(false);
    expect(isValidDuration(Infinity)).toBe(false);
  });
});

describe("backwards compatibility", () => {
  it("should work with existing numeric hotTTL values (hours)", () => {
    // Existing config: hotTTL: 72 (hours)
    const ttlMs = parseDuration(72, "h");
    expect(ttlMs).toBe(72 * 60 * 60 * 1000);
  });

  it("should work with existing numeric warmTTL values (days)", () => {
    // Existing config: warmTTL: 60 (days)
    const ttlMs = parseDuration(60, "d");
    expect(ttlMs).toBe(60 * 24 * 60 * 60 * 1000);
  });

  it("should allow new duration string format", () => {
    // New config: hotTTL: "1d"
    const ttlMs = parseDuration("1d", "h");
    expect(ttlMs).toBe(24 * 60 * 60 * 1000);
  });
});
