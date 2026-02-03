/**
 * Tests for session type detection functionality.
 * US-008: Detect session type at runtime
 */

import { describe, it, expect } from "vitest";
import { getSessionType } from "../hooks/auto-recall/handler.js";
import type { AgentContext } from "../hooks/auto-recall/handler.js";

describe("getSessionType", () => {
  it("should return 'main' when context.session is undefined", () => {
    const ctx: AgentContext = {};
    expect(getSessionType(ctx)).toBe("main");
  });

  it("should return 'main' when context.session.type is undefined", () => {
    const ctx: AgentContext = { session: {} };
    expect(getSessionType(ctx)).toBe("main");
  });

  it("should return 'main' for valid 'main' session type", () => {
    const ctx: AgentContext = { session: { type: "main" } };
    expect(getSessionType(ctx)).toBe("main");
  });

  it("should return 'cron' for valid 'cron' session type", () => {
    const ctx: AgentContext = { session: { type: "cron" } };
    expect(getSessionType(ctx)).toBe("cron");
  });

  it("should return 'spawned' for valid 'spawned' session type", () => {
    const ctx: AgentContext = { session: { type: "spawned" } };
    expect(getSessionType(ctx)).toBe("spawned");
  });

  it("should return 'main' for unknown session type", () => {
    const ctx: AgentContext = { session: { type: "unknown" } };
    expect(getSessionType(ctx)).toBe("main");
  });

  it("should return 'main' for empty string session type", () => {
    const ctx: AgentContext = { session: { type: "" } };
    expect(getSessionType(ctx)).toBe("main");
  });

  it("should return 'main' for invalid session type (number as string)", () => {
    const ctx: AgentContext = { session: { type: "123" } };
    expect(getSessionType(ctx)).toBe("main");
  });

  it("should preserve other context fields when detecting session type", () => {
    const ctx: AgentContext = {
      agentId: "agent-123",
      sessionKey: "session-456",
      workspaceDir: "/home/user/project",
      session: { type: "cron" },
    };
    expect(getSessionType(ctx)).toBe("cron");
    // Original context should be unchanged
    expect(ctx.agentId).toBe("agent-123");
    expect(ctx.sessionKey).toBe("session-456");
  });
});
