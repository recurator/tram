/**
 * Unit tests for configuration schema and resolution.
 *
 * Tests backward compatibility with boolean autoRecall (US-004):
 *   - Config autoRecall: true enables auto-recall with all defaults
 *   - Config autoRecall: false disables auto-recall entirely
 *   - Config autoRecall: { minScore: 0.3, ... } uses specified values
 *   - No runtime errors for any valid v0.1.x config
 */

import { describe, it, expect } from "vitest";
import {
  MemoryTieredConfigSchema,
  AutoRecallConfigSchema,
  resolveConfig,
  parseConfig,
  safeParseConfig,
  type MemoryTieredConfig,
  type ResolvedAutoRecallConfig,
} from "../config.js";

describe("AutoRecall Configuration", () => {
  describe("AutoRecallConfigSchema", () => {
    it("should accept boolean true", () => {
      const result = AutoRecallConfigSchema.parse(true);
      expect(result).toBe(true);
    });

    it("should accept boolean false", () => {
      const result = AutoRecallConfigSchema.parse(false);
      expect(result).toBe(false);
    });

    it("should accept object with all properties", () => {
      const input = {
        enabled: true,
        minScore: 0.3,
        maxItems: 15,
        budgets: { pinned: 20, hot: 50, warm: 20, cold: 10, archive: 0 },
      };
      const result = AutoRecallConfigSchema.parse(input);
      expect(result).toEqual(input);
    });

    it("should accept object with only enabled property", () => {
      const result = AutoRecallConfigSchema.parse({ enabled: false });
      expect(result).toEqual({ enabled: false });
    });

    it("should accept object with only minScore property", () => {
      const result = AutoRecallConfigSchema.parse({ minScore: 0.4 });
      expect(result).toMatchObject({ minScore: 0.4 });
    });

    it("should accept empty object (uses defaults)", () => {
      const result = AutoRecallConfigSchema.parse({});
      expect(result).toBeDefined();
    });
  });

  describe("resolveConfig with autoRecall: true (boolean)", () => {
    it("should resolve to enabled with all defaults", () => {
      const config = parseConfig({ autoRecall: true });
      const resolved = resolveConfig(config);

      expect(resolved.autoRecall.enabled).toBe(true);
      expect(resolved.autoRecall.minScore).toBe(0.2);
      expect(resolved.autoRecall.maxItems).toBe(20);
      expect(resolved.autoRecall.budgets).toEqual({
        pinned: 25,
        hot: 45,
        warm: 25,
        cold: 5,
        archive: 0,
      });
    });
  });

  describe("resolveConfig with autoRecall: false (boolean)", () => {
    it("should resolve to disabled with all defaults", () => {
      const config = parseConfig({ autoRecall: false });
      const resolved = resolveConfig(config);

      expect(resolved.autoRecall.enabled).toBe(false);
      expect(resolved.autoRecall.minScore).toBe(0.2);
      expect(resolved.autoRecall.maxItems).toBe(20);
      expect(resolved.autoRecall.budgets).toEqual({
        pinned: 25,
        hot: 45,
        warm: 25,
        cold: 5,
        archive: 0,
      });
    });
  });

  describe("resolveConfig with autoRecall: object", () => {
    it("should use specified minScore", () => {
      const config = parseConfig({ autoRecall: { minScore: 0.4 } });
      const resolved = resolveConfig(config);

      expect(resolved.autoRecall.enabled).toBe(true); // default
      expect(resolved.autoRecall.minScore).toBe(0.4);
    });

    it("should use specified maxItems", () => {
      const config = parseConfig({ autoRecall: { maxItems: 30 } });
      const resolved = resolveConfig(config);

      expect(resolved.autoRecall.maxItems).toBe(30);
    });

    it("should use specified budgets", () => {
      const config = parseConfig({
        autoRecall: {
          budgets: { pinned: 10, hot: 60, warm: 20, cold: 10 },
        },
      });
      const resolved = resolveConfig(config);

      expect(resolved.autoRecall.budgets).toEqual({
        pinned: 10,
        hot: 60,
        warm: 20,
        cold: 10,
        archive: 0,
      });
    });

    it("should use enabled: false when specified in object", () => {
      const config = parseConfig({ autoRecall: { enabled: false } });
      const resolved = resolveConfig(config);

      expect(resolved.autoRecall.enabled).toBe(false);
    });

    it("should fall back to injection config for missing values", () => {
      // Set custom injection values, then see if autoRecall uses them
      const config = parseConfig({
        injection: {
          minScore: 0.35,
          maxItems: 25,
          budgets: { pinned: 30, hot: 40, warm: 20, cold: 10 },
        },
        autoRecall: {}, // Empty object, should fall back to injection values
      });
      const resolved = resolveConfig(config);

      expect(resolved.autoRecall.minScore).toBe(0.35);
      expect(resolved.autoRecall.maxItems).toBe(25);
      expect(resolved.autoRecall.budgets).toEqual({
        pinned: 30,
        hot: 40,
        warm: 20,
        cold: 10,
        archive: 0,
      });
    });

    it("should override injection config when autoRecall values specified", () => {
      const config = parseConfig({
        injection: {
          minScore: 0.35,
          maxItems: 25,
        },
        autoRecall: {
          minScore: 0.5,
          maxItems: 10,
        },
      });
      const resolved = resolveConfig(config);

      // autoRecall values should take precedence
      expect(resolved.autoRecall.minScore).toBe(0.5);
      expect(resolved.autoRecall.maxItems).toBe(10);
      // injection config should remain unchanged
      expect(resolved.injection.minScore).toBe(0.35);
      expect(resolved.injection.maxItems).toBe(25);
    });
  });

  describe("resolveConfig with missing autoRecall (undefined)", () => {
    it("should use defaults when autoRecall not specified", () => {
      const config = parseConfig({});
      const resolved = resolveConfig(config);

      expect(resolved.autoRecall.enabled).toBe(true);
      expect(resolved.autoRecall.minScore).toBe(0.2);
      expect(resolved.autoRecall.maxItems).toBe(20);
    });
  });

  describe("v0.1.x backward compatibility", () => {
    it("should accept legacy config with autoRecall: true", () => {
      const legacyConfig = {
        dbPath: "/custom/path.db",
        autoCapture: true,
        autoRecall: true,
      };

      const result = safeParseConfig(legacyConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        const resolved = resolveConfig(result.data);
        expect(resolved.autoRecall.enabled).toBe(true);
      }
    });

    it("should accept legacy config with autoRecall: false", () => {
      const legacyConfig = {
        dbPath: "/custom/path.db",
        autoCapture: false,
        autoRecall: false,
      };

      const result = safeParseConfig(legacyConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        const resolved = resolveConfig(result.data);
        expect(resolved.autoRecall.enabled).toBe(false);
      }
    });

    it("should accept full v0.1.x config without errors", () => {
      const v01xConfig = {
        embedding: {
          provider: "local",
          local: { modelPath: "Xenova/all-MiniLM-L6-v2" },
        },
        dbPath: "/path/to/db.sqlite",
        autoCapture: true,
        autoRecall: true,
        tiers: {
          hot: { ttlHours: 48 },
          warm: { demotionDays: 30 },
          cold: { promotionUses: 5, promotionDays: 3 },
        },
        scoring: {
          similarity: 0.6,
          recency: 0.25,
          frequency: 0.15,
        },
        injection: {
          maxItems: 15,
          minScore: 0.25,
          budgets: { pinned: 20, hot: 50, warm: 20, cold: 10 },
        },
        decay: { intervalHours: 12 },
        context: { ttlHours: 8 },
      };

      const result = safeParseConfig(v01xConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        const resolved = resolveConfig(result.data);
        expect(resolved.autoRecall.enabled).toBe(true);
        expect(resolved.autoRecall.minScore).toBe(0.2); // Uses default since boolean
      }
    });

    it("should accept mixed v0.1.x and v0.2.x config", () => {
      const mixedConfig = {
        autoCapture: true,
        autoRecall: { minScore: 0.3, enabled: true },
        injection: { maxItems: 10 },
      };

      const result = safeParseConfig(mixedConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        const resolved = resolveConfig(result.data);
        expect(resolved.autoRecall.enabled).toBe(true);
        expect(resolved.autoRecall.minScore).toBe(0.3);
        expect(resolved.autoRecall.maxItems).toBe(10); // Falls back to injection
      }
    });
  });

  describe("MemoryTieredConfigSchema", () => {
    it("should default autoRecall to true when not provided", () => {
      const config = MemoryTieredConfigSchema.parse({});
      expect(config.autoRecall).toBe(true);
    });

    it("should preserve boolean autoRecall value", () => {
      const configTrue = MemoryTieredConfigSchema.parse({ autoRecall: true });
      const configFalse = MemoryTieredConfigSchema.parse({ autoRecall: false });

      expect(configTrue.autoRecall).toBe(true);
      expect(configFalse.autoRecall).toBe(false);
    });

    it("should preserve object autoRecall value", () => {
      const config = MemoryTieredConfigSchema.parse({
        autoRecall: { minScore: 0.5, enabled: false },
      });

      expect(typeof config.autoRecall).toBe("object");
      if (typeof config.autoRecall === "object") {
        expect(config.autoRecall.minScore).toBe(0.5);
        expect(config.autoRecall.enabled).toBe(false);
      }
    });
  });

  describe("ResolvedAutoRecallConfig type", () => {
    it("should always have enabled, minScore, maxItems, and budgets", () => {
      const resolved = resolveConfig(parseConfig({}));

      // Type check: these properties must exist
      const autoRecall: ResolvedAutoRecallConfig = resolved.autoRecall;
      expect(typeof autoRecall.enabled).toBe("boolean");
      expect(typeof autoRecall.minScore).toBe("number");
      expect(typeof autoRecall.maxItems).toBe("number");
      expect(typeof autoRecall.budgets).toBe("object");
      expect(typeof autoRecall.budgets.pinned).toBe("number");
      expect(typeof autoRecall.budgets.hot).toBe("number");
      expect(typeof autoRecall.budgets.warm).toBe("number");
      expect(typeof autoRecall.budgets.cold).toBe("number");
    });
  });
});
