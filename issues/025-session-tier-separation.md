# Issue 018: Session-Scoped Tier Separation (Configurable)

**Status:** Backlog
**Priority:** High
**Created:** 2026-02-02

## Problem

Currently all sessions (main, cron, spawned sub-agents) share the same memory store and auto-capture/inject settings. This causes:
- Cron jobs polluting HOT tier with transient data
- Sub-agent research notes flooding main context
- Irrelevant cross-session memory injection

## Solution: Tier Separation by Session Type

Different session types write to different default tiers:

| Session Type | Default Write Tier | Auto-Capture | Auto-Inject |
|--------------|-------------------|--------------|-------------|
| main | HOT | enabled | enabled |
| cron | COLD | disabled | enabled (read-only) |
| spawned | WARM | disabled | enabled (read-only) |

### Configuration

```json
{
  "sessions": {
    "main": {
      "defaultTier": "HOT",
      "autoCapture": true,
      "autoInject": true
    },
    "cron": {
      "defaultTier": "COLD",
      "autoCapture": false,
      "autoInject": true
    },
    "spawned": {
      "defaultTier": "WARM",
      "autoCapture": false,
      "autoInject": true
    }
  }
}
```

### Override at Runtime

Cron/spawned sessions can still explicitly store memories:
```
memory_store(text, tier="HOT")  // explicit override
```

But auto-capture respects session config.

## Implementation Steps

1. Add session type detection (main vs cron vs spawned)
2. Add per-session-type config to TRAM settings
3. Modify auto-capture hook to check session type
4. Modify default tier assignment based on session type
5. Allow explicit tier override in memory_store

## Migration

Existing memories have no session tag. Options:
- Leave as-is (all treated as main)
- Add migration to tag based on timestamps/patterns
- Only apply to new memories going forward ← recommended

## Success Criteria

- Cron jobs don't auto-capture by default
- Main session's HOT tier stays focused
- Explicit memory_store still works everywhere
- Configurable per deployment
