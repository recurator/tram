# Issue: Auto-capture grabs raw channel messages as noise

**Priority:** Medium  
**Component:** memory-tiered plugin (auto-capture hook)  
**Reporter:** Colin  
**Date:** 2026-02-01

---

## Summary

The `agent_end` auto-capture hook captures raw Telegram message metadata as memories, creating noise in the memory database.

## Example of Captured Noise

```
[Telegram Cx3 id:5209305635 +43s 2026-02-01 03:14 GMT+1] I need you to check how your current memory system work and where is it stored?
[message_id: 1161]
```

This is raw protocol format, not useful semantic content.

## Current Filters (insufficient)

```typescript
const MEMORY_TRIGGERS = [
  /zapamatuj si|pamatuj|remember/i,
  /preferuji|radši|nechci|prefer/i,
  // ... etc
];

function shouldCapture(text: string): boolean {
  if (text.length < 10 || text.length > 500) return false;
  if (text.includes("<relevant-memories>")) return false;
  if (text.startsWith("<") && text.includes("</")) return false;
  if (text.includes("**") && text.includes("\n-")) return false;
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) return false;
  return MEMORY_TRIGGERS.some((r) => r.test(text));
}
```

## Proposed Additional Filters

```typescript
function shouldCapture(text: string): boolean {
  // Existing filters...
  
  // NEW: Skip raw channel message metadata
  if (/^\[(?:Telegram|Discord|Signal|WhatsApp|Slack)\s+\w+\s+id:/i.test(text)) return false;
  
  // NEW: Skip message_id suffixes
  if (/\[message_id:\s*\d+\]/.test(text)) return false;
  
  // NEW: Skip system timestamps
  if (/^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(text)) return false;
  
  // NEW: Skip tool call outputs
  if (text.includes("toolCallId") || text.includes("function_results")) return false;
  
  return MEMORY_TRIGGERS.some((r) => r.test(text));
}
```

## Temporary Mitigation

Disabled auto-capture in config:
```json
"memory-tiered": {
  "config": {
    "autoCapture": false,  // ← disabled until filters improved
    "autoRecall": true
  }
}
```

Manual `memory_store` still works for explicit memories.

## Design Question

Should auto-capture even exist? Two philosophies:

1. **Keep it** — Useful for "remember I prefer X" statements without explicit tool call
2. **Remove it** — Agent should explicitly decide what to remember; auto-capture is inherently noisy

Current decision: **Disabled**, relying on manual `memory_store`. Can revisit when filters are battle-tested.

---

**Files affected:**
- `/usr/lib/node_modules/openclaw/extensions/memory-tiered/index.ts` (shouldCapture function, ~line 420)

---

## Resolution

**Status:** RESOLVED
**Date:** 2026-02-01
**Fix:** Noise filters implemented in `hooks/auto_capture.ts`

Added `NOISE_FILTERS` array and `isNoise()` function to filter out:
- Raw channel metadata (Telegram, Discord, Signal, WhatsApp, Slack)
- Message ID suffixes (`[message_id: ...]`)
- System timestamps at start of text
- Tool call outputs (`toolCallId`, `function_results`, XML tags)

Filtering applied at:
1. Full response level (early exit)
2. Segment level (during candidate extraction)
3. Sentence level (for long segments)

Auto-capture can now be safely re-enabled in config.
