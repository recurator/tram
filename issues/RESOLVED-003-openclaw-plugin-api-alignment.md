# Issue: Full memory-tiered not compatible with OpenClaw plugin API

**Priority:** High  
**Component:** memory-tiered plugin  
**Reporter:** Colin  
**Date:** 2026-02-01

---

## Summary

The full implementation (`projects/tiered-memory/implementation/extensions/memory-tiered/`) cannot be used as an OpenClaw plugin because it defines its own `PluginApi` interface that doesn't match OpenClaw's actual `OpenClawPluginApi`.

A simplified version was created to get it working, but it lacks most features (decay, promotion, pinning, scoring, etc.).

---

## Root Cause

The full version defines custom interfaces:

```typescript
// Current (incompatible)
export interface PluginApi {
  registerTool(name: string, tool: ToolDefinition): void;
  registerCli(parentCommand: string, description: string, subcommands: CliCommandDefinition[]): void;
  registerService(service: ServiceDefinition): void;
  on(event: string, handler: (...args: unknown[]) => unknown): void;
}
```

OpenClaw expects:

```typescript
// Required (from openclaw/plugin-sdk)
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

api.registerTool(toolDefinition, { name: "tool_name" });  // Different signature
api.registerCli(({ program }) => { ... }, { commands: ["cmd"] });  // Commander-based
api.on("before_agent_start", async (event) => { ... });  // event object, not raw prompt
api.logger.info("message");  // Logger access
api.resolvePath("~/path");  // Path resolution
api.pluginConfig;  // Config access
```

---

## What Needs to Change

### 1. Plugin Entry Point (`index.ts`)

**From:**
```typescript
const plugin: Plugin = {
  id: "memory-tiered",
  register: async (api: PluginApi, rawConfig: unknown) => { ... }
};
```

**To:**
```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const plugin = {
  id: "memory-tiered",
  kind: "memory" as const,
  configSchema: memoryConfigSchema,
  register(api: OpenClawPluginApi) {
    const cfg = memoryConfigSchema.parse(api.pluginConfig);
    // ...
  }
};

export default plugin;
```

### 2. Tool Registration

**From:**
```typescript
api.registerTool("memory_store", {
  name: "memory_store",
  description: "...",
  parameters: { type: "object", properties: { ... } },
  execute: async (input) => { ... }
});
```

**To:**
```typescript
import { Type } from "@sinclair/typebox";

api.registerTool(
  {
    name: "memory_store",
    label: "Memory Store",
    description: "...",
    parameters: Type.Object({
      text: Type.String({ description: "..." }),
      // ...
    }),
    async execute(_toolCallId, params) {
      // Return { content: [...], details: {...} }
    }
  },
  { name: "memory_store" }
);
```

### 3. CLI Registration

**From:**
```typescript
api.registerCli("memory", "description", [
  { name: "search", execute: async (args, opts) => { ... } }
]);
```

**To:**
```typescript
api.registerCli(
  ({ program }) => {
    const memory = program.command("memory").description("...");
    memory.command("search")
      .argument("<query>")
      .option("--limit <n>")
      .action(async (query, opts) => { ... });
  },
  { commands: ["memory"] }
);
```

### 4. Hook Signatures

**From:**
```typescript
api.on("before_agent_start", async (prompt: unknown) => {
  return { prependContext: "..." };
});
```

**To:**
```typescript
api.on("before_agent_start", async (event) => {
  if (!event.prompt) return;
  // event.prompt, event.messages, etc.
  return { prependContext: "..." };
});
```

### 5. Dependencies

Add to `package.json`:
```json
{
  "dependencies": {
    "@sinclair/typebox": "^0.32.0"  // For Type.Object schema
  }
}
```

Import from OpenClaw SDK:
```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
```

---

## Migration Steps

1. **Create adapter layer** — Wrap existing tool classes to match OpenClaw's execute signature
2. **Update index.ts** — Use OpenClaw's plugin structure
3. **Convert CLI** — Use Commander.js pattern instead of custom subcommand array
4. **Update hooks** — Handle `event` object instead of raw values
5. **Add openclaw.plugin.json** — Plugin manifest with configSchema
6. **Test with OpenClaw** — Install to `/usr/lib/node_modules/openclaw/extensions/`

---

## Estimated Effort

~2-4 hours for someone familiar with both codebases. The core logic (decay, scoring, promotion) doesn't change — only the plugin interface wiring.

---

## Reference

Working simplified version at:
```
/usr/lib/node_modules/openclaw/extensions/memory-tiered/index.ts
```

This shows the exact API patterns OpenClaw expects.
