# TRAM-008: Auto-Recall Hook Not Registering with OpenClaw

**Status:** Open  
**Severity:** High (core feature broken)  
**Reported:** 2026-02-01  
**Updated:** 2026-02-01  

---

## Summary

TRAM's auto-recall hook initializes but never registers with OpenClaw's hook event system. Memories are not injected into agent context despite `autoRecall: true` in config.

## Root Cause

TRAM does not use the documented plugin hook registration API. According to [OpenClaw Plugin Documentation](https://docs.openclaw.ai/plugin#plugin-hooks):

> Plugins can ship hooks and register them at runtime... use `registerPluginHooksFromDir` from `"openclaw/plugin-sdk"`

**Current TRAM behavior** (`releases/tram/index.ts` lines 509-513):
- Calls `initAutoRecallHook()` which only sets module-level state (db, embeddingProvider, etc.)
- Never calls `registerPluginHooksFromDir()` from the plugin SDK
- Never calls `api.registerHook()` to subscribe to events

**Result:** OpenClaw never knows the hook exists. The `agent:bootstrap` event fires, but TRAM's handler is never invoked.

## Evidence

1. **Manual `memory_recall` works** — proves the search/scoring logic is functional
2. **No `[TRAM] Injected X memories` log** — the handler never executes
3. **`openclaw status` shows** `Memory: enabled (plugin tram) · unavailable`

## Documentation References

- **Plugin hooks:** https://docs.openclaw.ai/plugin#plugin-hooks
- **Hook events:** https://docs.openclaw.ai/hooks (see `agent:bootstrap` event)
- **Hook structure:** Hooks need `HOOK.md` + `handler.ts` in a directory

## Files Involved

| File | Issue |
|------|-------|
| `releases/tram/index.ts` | Missing `registerPluginHooksFromDir()` call |
| `releases/tram/hooks/auto-recall/handler.ts` | Handler exists but is never registered |
| `releases/tram/hooks/auto-recall/HOOK.md` | Metadata correct (`events: ["agent:bootstrap"]`) |
| `releases/tram/package.json` | Declares `openclaw.hooks` array but OpenClaw doesn't auto-load plugin hooks |

## Required Fix

Per the documentation, the plugin should import and call:

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

// In register():
registerPluginHooksFromDir(api, "./hooks");
```

This will:
1. Discover hooks from the `./hooks` directory
2. Parse `HOOK.md` frontmatter for event subscriptions
3. Register handlers with OpenClaw's internal hook system

## Secondary Issue: Async Registration

The `register()` function in `index.ts` is marked `async`. Per the plugin loader (`/usr/lib/node_modules/openclaw/dist/plugins/loader.js`), async registration is warned and effectively ignored — the loader doesn't await the Promise.

This should be changed to synchronous registration (all async work should happen in tool `execute()` callbacks, not during registration).

## Acceptance Criteria

- [ ] `openclaw hooks list` shows `tram-auto-recall` with `plugin:tram` source
- [ ] Gateway logs show `[TRAM] Injected N memories into context` on each turn
- [ ] Agent context includes `<relevant-memories>` XML block when memories match

---

**Related:** TRAM-007 (CLI register not a function — same async issue)
