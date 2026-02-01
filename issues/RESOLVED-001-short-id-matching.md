# Issue: memory_forget doesn't match short IDs

**Priority:** Low  
**Component:** memory-tiered plugin  
**Reporter:** Colin  
**Date:** 2026-02-01

---

## Summary

The `memory_forget` tool claims success with short (8-char) memory IDs but doesn't actually update the database. Full UUIDs work correctly.

## Steps to Reproduce

1. Store a memory: `memory_store("test memory")`
2. Find its ID via recall — shows as `[ed5083f3]` in output
3. Forget with short ID: `memory_forget(memoryId: "ed5083f3")`
4. Tool returns: `"Memory ed5083f3 forgotten (soft delete - can be restored)."`
5. But `do_not_inject` remains `0` in database
6. Memory still appears in recall results

## Expected Behavior

Short ID prefix should match and update the record, OR tool should return error if no match found.

## Actual Behavior

Tool returns success message but database unchanged.

## Root Cause (Suspected)

In `memory_forget` tool execute function, the SQL likely uses exact match:
```sql
UPDATE memories SET do_not_inject = 1 WHERE id = ?
```

Should be:
```sql
UPDATE memories SET do_not_inject = 1 WHERE id LIKE ? || '%'
```

Or validate that `changes > 0` before returning success.

## Suggested Fix

```typescript
// Option A: Support prefix matching
const result = db.prepare(
  "UPDATE memories SET do_not_inject = 1 WHERE id LIKE ? || '%'"
).run(memoryId);

// Option B: Require full ID, return error if no match
const result = db.prepare(
  "UPDATE memories SET do_not_inject = 1 WHERE id = ?"
).run(memoryId);

if (result.changes === 0) {
  return { error: "No memory found with that ID" };
}
```

## Workaround

Use full UUID (available via direct DB query or from recall details).

---

**Files affected:**
- `/usr/lib/node_modules/openclaw/extensions/memory-tiered/index.ts` (line ~490, memory_forget execute)

---

## Resolution

**Status:** RESOLVED
**Date:** 2026-02-01
**Fix:** Option B implemented

The `memory_forget` tool now validates UUID format and throws explicit error for invalid IDs:

```typescript
// tools/memory_forget.ts:93-98
if (!UUID_REGEX.test(input.memoryId)) {
  throw new Error(
    `Invalid memory ID format: ${input.memoryId}. Expected UUID format.`
  );
}
```

Short IDs are now rejected with a clear error message instead of silently failing.
