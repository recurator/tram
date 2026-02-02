# TRAM-009: FTS5 Query Breaks on Hyphenated Words

**Status:** Resolved
**Severity:** Medium (causes query failures)
**Reported:** 2026-02-02
**Reporter:** Colin (via debugging session with Jabre)
**Resolved:** 2026-02-02

---

## Summary

FTS5 queries fail with SQL error when search terms contain hyphens. The hyphen is interpreted as a column reference rather than part of the search term.

## Reproduction

```bash
# This query fails:
openclaw memory search "hands-off"

# Or via tool:
memory_recall query="TRAM hands-off permission"
```

## Error Message

```
no such column: off
```

## Root Cause

The FTS5 query parser interprets `hands-off` as:
- `hands` (search term)
- `-off` (column reference or negation operator)

When `-off` is parsed, SQLite looks for a column named `off`, which doesn't exist.

## Fix Applied

Added `sanitizeFtsQuery()` method in `db/fts.ts` that wraps hyphenated words in double quotes before passing to FTS5. Also expanded the error catch block to handle "no such column" errors.

```typescript
private sanitizeFtsQuery(query: string): string {
  // Match hyphenated words and wrap in quotes
  return query.replace(/(?<!")(\b\w+(?:-\w+)+\b)(?!")/g, '"$1"');
}
```

The regex:
- Matches words with one or more hyphens (e.g., `hands-off`, `self-calibrating`)
- Uses negative lookbehind/lookahead to avoid double-quoting already quoted terms
- Wraps matched terms in double quotes for FTS5 literal matching

## Test Cases Added

Added test in `__tests__/sqlite.test.ts`:
- `hands-off` query works without throwing
- `hands-off auto-recall` with multiple hyphenated words
- `self-calibrating` compound hyphenated words

## Verification

All 196 tests pass including the new hyphenated query test.

## Related

- RESOLVED-005-fts5-query-bug.md (previous FTS5 issue with OR queries)

---

## Checklist
- [x] Root cause identified
- [x] Fix implemented
- [x] Build succeeds
- [x] Unit tests added
- [x] All tests passing
