# TRAM-010: SQLite Disk I/O Error During Plugin Initialization

**Status:** Resolved
**Severity:** Critical (plugin completely broken)
**Reported:** 2026-02-01
**Resolved:** 2026-02-01

---

## Resolution

The error was caused by the OpenClaw gateway process holding a lock on the SQLite database file. After restarting the Raspberry Pi, the lock was released and the database initialized correctly.

---

## Summary

TRAM plugin fails to initialize with `SqliteError: disk I/O error` when any memory command is executed. This prevents the entire plugin from loading.

## Error Output

```
[openclaw] Unhandled promise rejection: SqliteError: disk I/O error
    at Database.pragma (/home/jabre/.openclaw/extensions/tram/node_modules/better-sqlite3/lib/methods/pragma.js:10:27)
    at Database.initialize (/home/jabre/.openclaw/extensions/tram/dist/db/sqlite.js:39:13)
    at new Database (/home/jabre/.openclaw/extensions/tram/dist/db/sqlite.js:32:10)
    at register (/home/jabre/.openclaw/extensions/tram/dist/index.js:218:22)
```

## Likely Causes

1. **Database file corruption** - The SQLite database file may be corrupted
2. **File permissions** - The database file or directory may have incorrect permissions
3. **Disk full** - The disk may be out of space
4. **File locking** - Another process may have an exclusive lock on the database
5. **NFS/network filesystem issues** - If the database is on a network mount

## Files Involved

| File | Issue |
|------|-------|
| `db/sqlite.ts:39` | `Database.initialize()` calls pragma that triggers I/O error |
| `db/sqlite.ts:32` | Constructor calls initialize |
| `index.ts:218` | Plugin register() creates Database instance |

## Diagnostic Steps

1. Check if database file exists and permissions:
   ```bash
   ls -la ~/.openclaw/extensions/tram/*.db
   ls -la ~/.openclaw/memory/
   ```

2. Check disk space:
   ```bash
   df -h ~/.openclaw
   ```

3. Check for other processes using the database:
   ```bash
   lsof ~/.openclaw/extensions/tram/*.db 2>/dev/null
   fuser ~/.openclaw/extensions/tram/*.db 2>/dev/null
   ```

4. Test SQLite directly:
   ```bash
   sqlite3 ~/.openclaw/extensions/tram/tram.db "PRAGMA integrity_check;"
   ```

## Potential Fixes

1. **Add error handling** - Wrap database initialization in try/catch with graceful degradation
2. **Database recovery** - Implement automatic backup/restore on corruption detection
3. **Better error messages** - Surface the actual cause to users with actionable guidance

## Related Issues

- TRAM-011: CLI commands not registering (consequence of this issue)
