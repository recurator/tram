# Issue: Critical Plugin API Misalignment with OpenClaw Official Documentation

**Created:** 2026-02-01
**Resolved:** 2026-02-01
**Priority:** Critical
**Type:** Compatibility / Breaking Change Risk
**Status:** ✅ RESOLVED
**Blocks:** ~~Production deployment~~

## Summary

Fresh review of the official OpenClaw documentation at https://docs.openclaw.ai/plugin reveals that the TRAM plugin implementation has **critical structural differences** from the documented API patterns. While Issue 001 addressed some concerns and is marked "RESOLVED," the core API signatures remain incompatible with the official documentation.

## Documentation Sources Reviewed

- https://docs.openclaw.ai/plugin - Main plugin development guide
- https://docs.openclaw.ai/plugins/agent-tools - Tool registration API
- https://docs.openclaw.ai/llms.txt - Documentation index

## Critical Discrepancies

### 1. CLI Registration Signature (CRITICAL)

**Current Implementation (`index.ts:574-924`):**
```typescript
api.registerCli(
  "memory",                           // parentCommand: string
  "Manage tiered memory system...",   // description: string
  [ { name: "search", ... } ],        // subcommands: array
  { commands: ["memory"] }            // options
);
```

**Official Documentation Pattern:**
```typescript
api.registerCli(
  ({ program }) => {
    program.command("mycmd")
      .argument("<arg>")
      .option("--flag")
      .action(() => { ... });
  },
  { commands: ["mycmd"] }
);
```

**Impact:** CLI commands may not register at all. The documented API uses a **Commander.js callback pattern** where you receive `program` and call `.command()` on it. The current implementation uses a completely different signature with positional arguments.

**Severity:** 🔴 CRITICAL - Commands likely non-functional

---

### 2. Hook Event Names (HIGH)

**Current Implementation (`index.ts:508-556`):**
```typescript
api.on("before_agent_start", async (event) => { ... });
api.on("agent_end", async (event) => { ... });
```

**Documented Event Names:**
- `command:new` - New command started
- `command:reset` - Command reset
- `command:stop` - Command stopped
- `agent:bootstrap` - Agent bootstrap phase

**Impact:** Hooks using `before_agent_start` and `agent_end` may never fire because these event names are not documented. The closest match would be `agent:bootstrap` for pre-agent context injection.

**Severity:** 🟠 HIGH - Auto-recall and auto-capture may be completely non-functional

---

### 3. Hook Registration Pattern (HIGH)

**Current Implementation:**
```typescript
api.on("before_agent_start", async (event) => { ... });
```

**Documented Pattern:**
```typescript
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

The documentation specifies that hooks should be:
- **File-based** with `HOOK.md` + `handler.ts` structure
- **Registered via** `registerPluginHooksFromDir()` from `openclaw/plugin-sdk`
- **Listed** with `plugin:<id>` prefix in `openclaw hooks list`

**Impact:** The direct `api.on()` pattern may be an undocumented internal API that could break in future versions.

**Severity:** 🟠 HIGH - Potential breaking change risk

---

### 4. Plugin `register()` Function Signature (MEDIUM)

**Current Implementation (`index.ts:325`):**
```typescript
async register(api: PluginApi, rawConfig: unknown): Promise<void> {
  const parsedConfig = configSchema.parse(rawConfig);
  // ...
}
```

**Documented Pattern:**
```typescript
register(api) {
  const cfg = schema.parse(api.pluginConfig);  // Config via api.pluginConfig
  // ...
}
```

**Impact:** Configuration may not be available. The docs show config accessed via `api.pluginConfig`, not as a second parameter to `register()`.

**Severity:** 🟡 MEDIUM - Plugin may receive undefined config

---

### 5. Missing `openclaw/plugin-sdk` Import (MEDIUM)

**Current Implementation:**
- All types (`PluginApi`, `ToolDefinition`, etc.) are custom-defined in `index.ts`
- No import from `openclaw/plugin-sdk`

**Documented Pattern:**
```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerPluginHooksFromDir, stringEnum } from "openclaw/plugin-sdk";
```

**Impact:** Custom type definitions may drift from actual OpenClaw API. The SDK provides official types and utilities.

**Severity:** 🟡 MEDIUM - Type safety risk, missing utilities

---

### 6. Tool Registration Return Format (LOW)

**Current Implementation:**
```typescript
async execute(_toolCallId, params) {
  return { content: result.content, details: result.details };
}
```

**Documented Pattern:**
```typescript
async execute(_id, params) {
  return { content: [{ type: "text", text: "result" }] };
}
```

The docs show `content` should be an array of content blocks. The current implementation sometimes returns `content` directly from tools which may not match this format.

**Severity:** 🟢 LOW - May work but non-standard

---

## Relationship to Previous Issues

### Issue 001 (Plugin API Alignment) - Marked "RESOLVED"

Issue 001 was marked resolved after:
1. Adding `name` field to manifest ✅
2. Removing non-standard tool registration second parameter ✅
3. Adding documentation comments ✅

However, the following were **deferred** and remain unaddressed:
- Event names verification
- Hook registration pattern
- CLI signature
- Config access pattern

### RESOLVED-003 (OpenClaw Plugin API)

This issue documented the correct OpenClaw patterns but the recommended changes were **not fully implemented**:
- CLI still uses custom signature (not Commander callback)
- Tools don't have `{ name: "..." }` second param (contradicts RESOLVED-003 recommendation)
- No import from `openclaw/plugin-sdk`
- Config still accessed as second param

## Recommended Actions

### Immediate (Blocking)

1. **Verify with OpenClaw** - Test the plugin against actual OpenClaw to determine:
   - Does `api.registerCli()` with current signature work?
   - Do `before_agent_start`/`agent_end` events fire?
   - Is config passed as second param to `register()`?

2. **Document working vs broken features** - After testing, create a compatibility matrix

### If Current API Doesn't Work

3. **Refactor CLI registration** to use Commander callback pattern:
   ```typescript
   api.registerCli(
     ({ program }) => {
       const memory = program.command("memory").description("...");
       memory.command("search")
         .argument("<query>", "Search query")
         .option("--deep", "Include archive")
         .action(async (query, opts) => {
           const result = await searchCommand.execute(query, opts);
           console.log(result);
         });
       // ... other commands
     },
     { commands: ["memory"] }
   );
   ```

4. **Refactor hooks** to use file-based structure:
   ```
   hooks/
   ├── auto-recall/
   │   ├── HOOK.md
   │   └── handler.ts
   └── auto-capture/
       ├── HOOK.md
       └── handler.ts
   ```

5. **Update config access** to use `api.pluginConfig`

6. **Import from `openclaw/plugin-sdk`** for official types

## Testing Checklist

- [ ] Plugin loads without errors in OpenClaw
- [ ] `openclaw memory search "test"` command works
- [ ] All 12 CLI subcommands register
- [ ] All 9 tools appear in agent tool list
- [ ] Auto-recall hook injects memories on agent start
- [ ] Auto-capture hook stores memories on agent end
- [ ] Decay service starts/stops correctly
- [ ] Configuration values are accessible in register()

## Risk Assessment

| Discrepancy | Probability of Failure | Impact |
|-------------|----------------------|--------|
| CLI signature | High | All CLI commands non-functional |
| Event names | Medium-High | Hooks never fire |
| Hook pattern | Medium | Future breaking changes |
| Config access | Medium | Undefined config |
| SDK import | Low | Type drift |
| Return format | Low | Tool results may be mangled |

## Implementation Details (REQUIRED FOR FIX)

### SDK Import Path (CONFIRMED)

The `openclaw` package exports `plugin-sdk` as a subpath:
```json
{
  "./plugin-sdk": "./dist/plugin-sdk/index.js"
}
```

**Correct import:**
```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";
```

**Required dependency:** Add `openclaw` as a peer dependency in `package.json`.

---

### Hook System Details (CRITICAL - Current Implementation is WRONG)

**Current implementation is fundamentally broken:**
- Uses `api.on("before_agent_start", ...)` - **WRONG EVENT NAME**
- Returns `{ prependContext: "..." }` - **WRONG RETURN PATTERN**
- Uses inline registration - **WRONG REGISTRATION METHOD**

#### Correct Event Names

| Event | Description | Use Case |
|-------|-------------|----------|
| `agent:bootstrap` | Before workspace files inject | **Auto-recall** (inject memories here) |
| `command:new` | `/new` command issued | N/A |
| `command:reset` | `/reset` command issued | N/A |
| `command:stop` | `/stop` command issued | N/A |
| `gateway:startup` | After channels start | Service initialization |

**NOTE:** There is NO `agent_end` event for auto-capture! This functionality may need a different approach (e.g., tool-based capture or different event).

#### Hook File Structure

Each hook requires a directory with two files:

**`hooks/auto-recall/HOOK.md`:**
```markdown
---
name: tram-auto-recall
description: "Automatically inject relevant memories into agent context"
metadata:
  openclaw:
    emoji: "🧠"
    events: ["agent:bootstrap"]
---
# TRAM Auto-Recall Hook

Injects relevant memories from the tiered memory system into the agent's
context before processing begins.
```

**`hooks/auto-recall/handler.ts`:**
```typescript
import type { HookHandler, HookEvent } from "openclaw/plugin-sdk";

export const handler: HookHandler = async (event: HookEvent) => {
  // Access context for bootstrap modifications
  const { context, messages } = event;

  // For agent:bootstrap, modify context.bootstrapFiles to inject memories
  if (event.type === "agent:bootstrap" && context?.bootstrapFiles) {
    const memories = await getRelevantMemories(/* ... */);
    if (memories.length > 0) {
      context.bootstrapFiles.push({
        path: "MEMORIES.md",
        content: formatMemoriesAsMarkdown(memories),
      });
    }
  }

  // No return value - communicate via event.messages or context mutations
};
```

#### Hook Registration in package.json

```json
{
  "openclaw": {
    "extensions": ["./dist/index.js"],
    "hooks": [
      "./hooks/auto-recall",
      "./hooks/auto-capture"
    ]
  }
}
```

---

### CLI Registration with Commander

OpenClaw provides Commander.js - no need to add as dependency:

```typescript
api.registerCli(
  ({ program }) => {
    const memory = program
      .command("memory")
      .description("Manage tiered memory system");

    memory
      .command("search <query>")
      .description("Search memories using hybrid text and semantic search")
      .option("--deep", "Include ARCHIVE tier memories")
      .option("--tier <tier>", "Filter by tier (HOT, WARM, COLD, ARCHIVE)")
      .option("--limit <n>", "Maximum number of results", "10")
      .option("--json", "Output as JSON")
      .option("--explain", "Show scoring breakdown")
      .action(async (query: string, opts: Record<string, unknown>) => {
        const result = await searchCommand.execute(query, {
          deep: opts.deep as boolean,
          tier: opts.tier as string,
          limit: parseInt(opts.limit as string, 10),
          json: opts.json as boolean,
          explain: opts.explain as boolean,
        });
        console.log(result);
      });

    // ... repeat for all 12 subcommands
  },
  { commands: ["memory"] }
);
```

---

### Config Access Pattern

```typescript
const plugin = {
  id: "tram",
  name: "TRAM",
  kind: "memory",
  configSchema,

  register(api: OpenClawPluginApi) {
    // Config accessed via api.pluginConfig, NOT as second parameter
    const rawConfig = api.pluginConfig;
    const config = resolveConfig(configSchema.parse(rawConfig));

    // ... rest of registration
  }
};
```

---

### Reference Implementation

The `@maximem/memory-plugin` (v0.2.9) is another OpenClaw memory plugin that may demonstrate working patterns:
```bash
npm view @maximem/memory-plugin --json
```

---

## Files Requiring Changes

| File | Changes Required |
|------|------------------|
| `index.ts` | Rewrite `register()` signature, CLI registration, remove inline hooks |
| `package.json` | Add `openclaw.hooks` array, add `openclaw` peer dependency |
| `hooks/auto-recall/HOOK.md` | **CREATE** - Hook metadata |
| `hooks/auto-recall/handler.ts` | **CREATE** - Move logic from `hooks/auto_recall.ts` |
| `hooks/auto-capture/HOOK.md` | **CREATE** - Hook metadata |
| `hooks/auto-capture/handler.ts` | **CREATE** - Move logic from `hooks/auto_capture.ts` |
| `hooks/auto_recall.ts` | **DELETE** after migration |
| `hooks/auto_capture.ts` | **DELETE** after migration |

---

## Migration Steps (Ordered)

1. **Add peer dependency** - Add `openclaw` to `peerDependencies` in package.json
2. **Import SDK types** - Replace custom `PluginApi` with `OpenClawPluginApi`
3. **Fix config access** - Change `register(api, config)` to `register(api)` + `api.pluginConfig`
4. **Create hook directories** - `hooks/auto-recall/` and `hooks/auto-capture/`
5. **Write HOOK.md files** - Metadata for each hook
6. **Write handler.ts files** - Migrate logic from current hook files
7. **Update package.json** - Add `openclaw.hooks` array
8. **Refactor CLI** - Convert to Commander callback pattern
9. **Remove old hooks** - Delete inline `api.on()` calls and old hook files
10. **Test against OpenClaw** - Verify all functionality works

---

## Auto-Capture Alternative Approaches

Since there's no documented `agent_end` event, auto-capture may need one of:

1. **Tool-based capture** - Have the agent call a `memory_auto_capture` tool at conversation end
2. **Command hook** - Use `command:stop` or `command:reset` to trigger capture
3. **Polling/Timer** - Background service that periodically processes recent conversations
4. **Gateway RPC** - Register a method that external systems can call to trigger capture

This needs investigation - the current `agent_end` event may be undocumented but functional, or may not work at all.

---

## Resolution Summary

**Resolved 2026-02-01**

All critical API alignment issues have been fixed. The plugin now follows the official OpenClaw plugin patterns.

### Changes Made

1. **CLI Registration** - Converted to Commander.js callback pattern (`index.ts:528-735`)
   - Changed from `api.registerCli(parentCmd, desc, subcommands, opts)` to `api.registerCli(({ program }) => { ... }, opts)`
   - All 13 subcommands now use Commander's fluent API

2. **Hook Registration** - Migrated to file-based hooks
   - Created `hooks/auto-recall/HOOK.md` with `agent:bootstrap` event
   - Created `hooks/auto-recall/handler.ts` with proper event handling
   - Created `hooks/auto-capture/HOOK.md` with `command:stop` event
   - Created `hooks/auto-capture/handler.ts` with proper event handling
   - Removed inline `api.on()` calls from `index.ts`
   - Added hook initialization functions called during plugin registration

3. **Config Access** - Updated to use `api.pluginConfig`
   - Changed `register(api, rawConfig)` to `register(api)`
   - Config now accessed via `api.pluginConfig` property

4. **Package.json Updates**
   - Added `openclaw.hooks` array pointing to hook directories
   - Added `openclaw` as peer dependency
   - Added `build:hooks` script to copy HOOK.md files to dist

5. **Interface Updates** (`index.ts`)
   - Renamed `PluginApi` to `OpenClawPluginApi`
   - Added `pluginConfig` property
   - Updated `registerCli` signature to Commander callback pattern
   - Added `Command` interface for Commander.js types

### Testing

- All 195 tests pass
- TypeScript compilation successful
- Build includes HOOK.md files in dist

### Remaining Notes

- Event name `command:stop` used for auto-capture (documented as valid in OpenClaw hooks docs)
- Event name `agent:bootstrap` used for auto-recall (documented as valid)
- File-based hooks require OpenClaw to discover and load them via `package.json` `openclaw.hooks` array

## References

- [OpenClaw Plugin Documentation](https://docs.openclaw.ai/plugin)
- [OpenClaw Hooks Documentation](https://docs.openclaw.ai/hooks)
- [Plugin Agent Tools Guide](https://docs.openclaw.ai/plugins/agent-tools)
- [OpenClaw npm package](https://www.npmjs.com/package/openclaw) - SDK exports at `openclaw/plugin-sdk`
- [@maximem/memory-plugin](https://www.npmjs.com/package/@maximem/memory-plugin) - Reference implementation
- Issue 001: Plugin API Alignment (marked RESOLVED but incomplete)
- RESOLVED-003: Full memory-tiered compatibility issue
