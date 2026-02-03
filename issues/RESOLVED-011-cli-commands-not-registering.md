# TRAM-011: CLI Commands Not Registering with OpenClaw

**Status:** Resolved
**Severity:** High (CLI unusable)
**Reported:** 2026-02-01
**Resolved:** 2026-02-01

---

## Resolution

OpenClaw flattens plugin CLI commands to the root level instead of allowing nested subcommands. The fix required:

1. **Remove nested command structure** - Changed from `program.command("tram").command("list")` to `program.command("tram-list")`
2. **Prefix all commands** - All TRAM commands now use `tram-*` prefix to avoid conflicts with OpenClaw's built-in commands
3. **Update commands array** - Changed `{ commands: ["tram"] }` to list all individual commands

**New command names:**
- `openclaw tram-search <query>` - Hybrid search
- `openclaw tram-list` - List memories with filters
- `openclaw tram-stats` - Database statistics
- `openclaw tram-forget <id>` - Soft-delete memory
- `openclaw tram-restore <id>` - Restore deleted memory
- `openclaw tram-pin <id>` - Pin memory
- `openclaw tram-unpin <id>` - Unpin memory
- `openclaw tram-explain <id>` - Explain scoring
- `openclaw tram-decay run` - Run decay process
- `openclaw tram-set-context <text>` - Set context
- `openclaw tram-clear-context` - Clear context
- `openclaw tram-index` - Index legacy files
- `openclaw tram-migrate` - Migrate from LanceDB

---

## Original Summary

TRAM CLI commands (`memory stats`, `memory list`, etc.) were not being registered with OpenClaw. Commands returned "unknown command" errors.

## Root Cause Analysis

This issue is **likely a consequence of TRAM-010** (SQLite disk I/O error). When the plugin fails to initialize due to the database error:

1. `register()` function throws during Database instantiation (line 218)
2. `registerCli()` is never reached (line 527+)
3. OpenClaw falls back to built-in `memory` commands which don't include TRAM's commands

## Evidence

1. `openclaw memory status` works - this is OpenClaw's built-in command, not TRAM's
2. `openclaw memory search` triggers the SQLite error - TRAM is being invoked but failing
3. `openclaw memory stats` returns "unknown command" - TRAM's CLI never registered

## Files Involved

| File | Role |
|------|------|
| `index.ts:527-600` | CLI registration via `api.registerCli()` |
| `cli/stats.ts` | Stats command implementation |
| `cli/list.ts` | List command implementation |
| `cli/search.ts` | Search command implementation |

## Resolution

1. **Fix TRAM-010 first** - The SQLite error is preventing plugin initialization
2. **Add defensive registration** - Consider registering CLI commands before database init
3. **Graceful degradation** - Allow CLI to load even if database is unavailable (with appropriate error messages)

## Acceptance Criteria

- [ ] `openclaw memory stats` shows TRAM database statistics
- [ ] `openclaw memory list` lists memories with tier/limit options
- [ ] `openclaw memory search <query>` performs hybrid search
- [ ] All TRAM CLI commands appear in `openclaw memory --help`

## Related Issues

- TRAM-010: SQLite disk I/O error (root cause)
