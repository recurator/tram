/**
 * Unit tests for profile presets and resolution
 *
 * Tests:
 * - Built-in profile presets (retrieval, decay, promotion)
 * - Custom profile definitions
 * - Profile resolution with source tracking
 */

import { describe, it, expect } from "vitest";
import {
  RETRIEVAL_PROFILES,
  DECAY_PROFILES,
  PROMOTION_PROFILES,
  getRetrievalProfile,
  getDecayProfile,
  getPromotionProfile,
  resolveRetrievalProfile,
  resolveDecayProfile,
  resolvePromotionProfile,
  getAvailableProfiles,
  isValidProfile,
  type ProfileContext,
} from "../core/profiles.js";

describe("Built-in profiles", () => {
  describe("RETRIEVAL_PROFILES", () => {
    it("should have all expected profiles", () => {
      expect(RETRIEVAL_PROFILES).toHaveProperty("narrow");
      expect(RETRIEVAL_PROFILES).toHaveProperty("focused");
      expect(RETRIEVAL_PROFILES).toHaveProperty("balanced");
      expect(RETRIEVAL_PROFILES).toHaveProperty("broad");
      expect(RETRIEVAL_PROFILES).toHaveProperty("expansive");
    });

    it("should have correct narrow profile", () => {
      const profile = RETRIEVAL_PROFILES.narrow;
      expect(profile.hot).toBe(70);
      expect(profile.warm).toBe(20);
      expect(profile.cold).toBe(10);
      expect(profile.archive).toBe(0);
    });

    it("should have correct focused profile (default)", () => {
      const profile = RETRIEVAL_PROFILES.focused;
      expect(profile.hot).toBe(50);
      expect(profile.warm).toBe(30);
      expect(profile.cold).toBe(15);
      expect(profile.archive).toBe(5);
    });

    it("should have correct balanced profile", () => {
      const profile = RETRIEVAL_PROFILES.balanced;
      expect(profile.hot).toBe(30);
      expect(profile.warm).toBe(30);
      expect(profile.cold).toBe(30);
      expect(profile.archive).toBe(10);
    });

    it("should have correct broad profile", () => {
      const profile = RETRIEVAL_PROFILES.broad;
      expect(profile.hot).toBe(5);
      expect(profile.warm).toBe(25);
      expect(profile.cold).toBe(25);
      expect(profile.archive).toBe(45);
    });

    it("should have correct expansive profile", () => {
      const profile = RETRIEVAL_PROFILES.expansive;
      expect(profile.hot).toBe(0);
      expect(profile.warm).toBe(5);
      expect(profile.cold).toBe(15);
      expect(profile.archive).toBe(80);
    });

    it("all profiles should sum to 100%", () => {
      for (const [name, profile] of Object.entries(RETRIEVAL_PROFILES)) {
        const sum = profile.hot + profile.warm + profile.cold + profile.archive;
        expect(sum, `Profile ${name} should sum to 100`).toBe(100);
      }
    });
  });

  describe("DECAY_PROFILES", () => {
    it("should have all expected profiles", () => {
      expect(DECAY_PROFILES).toHaveProperty("forgetful");
      expect(DECAY_PROFILES).toHaveProperty("casual");
      expect(DECAY_PROFILES).toHaveProperty("attentive");
      expect(DECAY_PROFILES).toHaveProperty("thorough");
      expect(DECAY_PROFILES).toHaveProperty("retentive");
    });

    it("should have correct forgetful profile", () => {
      const profile = DECAY_PROFILES.forgetful;
      expect(profile.hotTtl).toBe("5m");
      expect(profile.warmTtl).toBe("15m");
      expect(profile.coldTtl).toBe("1h");
    });

    it("should have correct thorough profile (default)", () => {
      const profile = DECAY_PROFILES.thorough;
      expect(profile.hotTtl).toBe("1d");
      expect(profile.warmTtl).toBe("7d");
      expect(profile.coldTtl).toBe("30d");
    });

    it("should have correct retentive profile", () => {
      const profile = DECAY_PROFILES.retentive;
      expect(profile.hotTtl).toBe("7d");
      expect(profile.warmTtl).toBe("60d");
      expect(profile.coldTtl).toBe("180d");
    });
  });

  describe("PROMOTION_PROFILES", () => {
    it("should have all expected profiles", () => {
      expect(PROMOTION_PROFILES).toHaveProperty("forgiving");
      expect(PROMOTION_PROFILES).toHaveProperty("fair");
      expect(PROMOTION_PROFILES).toHaveProperty("selective");
      expect(PROMOTION_PROFILES).toHaveProperty("demanding");
      expect(PROMOTION_PROFILES).toHaveProperty("ruthless");
    });

    it("should have correct forgiving profile", () => {
      const profile = PROMOTION_PROFILES.forgiving;
      expect(profile.uses).toBe(1);
      expect(profile.days).toBe(1);
    });

    it("should have correct selective profile (default)", () => {
      const profile = PROMOTION_PROFILES.selective;
      expect(profile.uses).toBe(3);
      expect(profile.days).toBe(2);
    });

    it("should have correct ruthless profile", () => {
      const profile = PROMOTION_PROFILES.ruthless;
      expect(profile.uses).toBe(10);
      expect(profile.days).toBe(5);
    });
  });
});

describe("getRetrievalProfile", () => {
  it("should return built-in profile", () => {
    const profile = getRetrievalProfile("focused");
    expect(profile).toEqual(RETRIEVAL_PROFILES.focused);
  });

  it("should return undefined for unknown profile", () => {
    const profile = getRetrievalProfile("nonexistent");
    expect(profile).toBeUndefined();
  });

  it("should prefer custom profile over built-in", () => {
    const custom = {
      focused: { hot: 100, warm: 0, cold: 0, archive: 0 },
    };
    const profile = getRetrievalProfile("focused", custom);
    expect(profile?.hot).toBe(100);
  });
});

describe("getDecayProfile", () => {
  it("should return built-in profile", () => {
    const profile = getDecayProfile("thorough");
    expect(profile).toEqual(DECAY_PROFILES.thorough);
  });

  it("should return undefined for unknown profile", () => {
    const profile = getDecayProfile("nonexistent");
    expect(profile).toBeUndefined();
  });
});

describe("getPromotionProfile", () => {
  it("should return built-in profile", () => {
    const profile = getPromotionProfile("selective");
    expect(profile).toEqual(PROMOTION_PROFILES.selective);
  });

  it("should return undefined for unknown profile", () => {
    const profile = getPromotionProfile("nonexistent");
    expect(profile).toBeUndefined();
  });
});

describe("resolveRetrievalProfile", () => {
  it("should return builtin default with empty context", () => {
    const result = resolveRetrievalProfile({});
    expect(result.profile).toBe("focused");
    expect(result.source).toBe("builtin");
    expect(result.values).toEqual(RETRIEVAL_PROFILES.focused);
  });

  it("should use global default", () => {
    const context: ProfileContext = {
      globalDefaults: { retrieval: "balanced" },
    };
    const result = resolveRetrievalProfile(context);
    expect(result.profile).toBe("balanced");
    expect(result.source).toBe("global");
  });

  it("should prefer agent config over global", () => {
    const context: ProfileContext = {
      globalDefaults: { retrieval: "balanced" },
      agentConfig: { retrieval: "broad" },
    };
    const result = resolveRetrievalProfile(context);
    expect(result.profile).toBe("broad");
    expect(result.source).toMatch(/^agent:/);
  });

  it("should prefer session override over agent", () => {
    const context: ProfileContext = {
      globalDefaults: { retrieval: "balanced" },
      agentConfig: { retrieval: "broad" },
      sessionOverrides: { retrieval: "narrow" },
    };
    const result = resolveRetrievalProfile(context);
    expect(result.profile).toBe("narrow");
    expect(result.source).toBe("session");
  });

  it("should fall back to builtin if profile not found", () => {
    const context: ProfileContext = {
      globalDefaults: { retrieval: "nonexistent" },
    };
    const result = resolveRetrievalProfile(context);
    expect(result.profile).toBe("focused");
    expect(result.source).toBe("builtin");
  });
});

describe("resolveDecayProfile", () => {
  it("should return builtin default with empty context", () => {
    const result = resolveDecayProfile({});
    expect(result.profile).toBe("thorough");
    expect(result.source).toBe("builtin");
  });

  it("should use session override", () => {
    const context: ProfileContext = {
      sessionOverrides: { decay: "forgetful" },
    };
    const result = resolveDecayProfile(context);
    expect(result.profile).toBe("forgetful");
    expect(result.source).toBe("session");
  });
});

describe("resolvePromotionProfile", () => {
  it("should return builtin default with empty context", () => {
    const result = resolvePromotionProfile({});
    expect(result.profile).toBe("selective");
    expect(result.source).toBe("builtin");
  });

  it("should use session override", () => {
    const context: ProfileContext = {
      sessionOverrides: { promotion: "forgiving" },
    };
    const result = resolvePromotionProfile(context);
    expect(result.profile).toBe("forgiving");
    expect(result.source).toBe("session");
  });
});

describe("getAvailableProfiles", () => {
  it("should return all built-in retrieval profiles", () => {
    const profiles = getAvailableProfiles("retrieval");
    expect(profiles).toContain("narrow");
    expect(profiles).toContain("focused");
    expect(profiles).toContain("balanced");
    expect(profiles).toContain("broad");
    expect(profiles).toContain("expansive");
  });

  it("should include custom profiles", () => {
    const custom: ProfileContext["customProfiles"] = {
      retrieval: {
        custom1: { hot: 50, warm: 50, cold: 0, archive: 0 },
      },
    };
    const profiles = getAvailableProfiles("retrieval", custom);
    expect(profiles).toContain("custom1");
    expect(profiles).toContain("focused");
  });

  it("should return sorted unique list", () => {
    const profiles = getAvailableProfiles("decay");
    const sorted = [...profiles].sort();
    expect(profiles).toEqual(sorted);
  });
});

describe("isValidProfile", () => {
  it("should return true for valid built-in profiles", () => {
    expect(isValidProfile("retrieval", "focused")).toBe(true);
    expect(isValidProfile("decay", "thorough")).toBe(true);
    expect(isValidProfile("promotion", "selective")).toBe(true);
  });

  it("should return false for unknown profiles", () => {
    expect(isValidProfile("retrieval", "nonexistent")).toBe(false);
    expect(isValidProfile("decay", "nonexistent")).toBe(false);
    expect(isValidProfile("promotion", "nonexistent")).toBe(false);
  });

  it("should return true for custom profiles", () => {
    const custom: ProfileContext["customProfiles"] = {
      retrieval: {
        myprofile: { hot: 50, warm: 50, cold: 0, archive: 0 },
      },
    };
    expect(isValidProfile("retrieval", "myprofile", custom)).toBe(true);
  });
});
