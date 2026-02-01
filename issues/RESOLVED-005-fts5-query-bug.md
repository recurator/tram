# TRAM Auto-Recall Returns No Results Due to FTS5 AND Query Bug

## Summary
The `before_agent_start` hook in TRAM fails to inject memories because `extractKeyTerms()` joins search terms with spaces, causing FTS5 to interpret them as implicit AND (all terms required), returning zero or near-zero results.

## Severity
**High** — Core feature (auto-injection) completely broken.

## Affected Version
- @openclaw/tram v0.1.0

## Symptoms
- `memory_recall` tool works correctly (finds memories)
- `before_agent_start` hook is called but returns `{ memoriesInjected: 0 }`
- No `<relevant-memories>` block injected into agent context
- Debug logs show `hybridResults.length === 0`

## Root Cause
In `hooks/auto_recall.ts`, the `execute()` method builds a search query:

```typescript
const keyTerms = this.extractKeyTerms(prompt);
const searchQuery = keyTerms.length > 0 ? keyTerms.join(" ") : prompt.trim();
```

FTS5 interprets space-separated terms as **implicit AND**:
- Query: `tram memory` → Requires BOTH "tram" AND "memory" in same record
- Result: 0-1 matches (most memories contain only one term)

The `memory_recall` tool uses a different code path that doesn't have this bug.

## Reproduction
1. Store memories with various single-word topics
2. Send a message with multiple keywords: "Tell me about TRAM memory"
3. Observe: hook returns no results, but `memory_recall "TRAM"` works

## Fix
Change line ~152 in `hooks/auto_recall.ts`:

```diff
- const searchQuery = keyTerms.length > 0 ? keyTerms.join(" ") : prompt.trim();
+ const searchQuery = keyTerms.length > 0 ? keyTerms.join(" OR ") : prompt.trim();
```

This makes FTS5 return records matching ANY term (union) instead of ALL terms (intersection).

## Verification
```
Before: "tram memory testing" → 1 result
After:  "tram OR memory OR testing" → 13 results
```

## Additional Notes
- The `memory_recall` tool in `tools/memory_recall.ts` should be audited for similar issues
- Consider adding integration tests for auto-recall with multi-word prompts
- The stop-word filtering in `extractKeyTerms()` is aggressive — short prompts like "Any progress?" may still return empty after filtering

## Related Files
- `hooks/auto_recall.ts` — Main bug location
- `db/vectors.ts` — `hybridSearch()` implementation
- `tools/memory_recall.ts` — Working implementation for comparison

## Checklist
- [x] Root cause identified
- [x] Fix implemented
- [x] Build succeeds
- [ ] Unit tests added
- [ ] Gateway restarted to verify fix
- [ ] PR submitted
