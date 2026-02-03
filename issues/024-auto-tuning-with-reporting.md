# Issue 017: Automated Tuning with User Reporting

**Status:** Backlog
**Priority:** Medium
**Created:** 2026-02-02

## Summary

TRAM should auto-tune parameters and report changes to the user, since tuning affects token usage and memory behavior.

## Design

### Automatic Adjustments
When TRAM auto-adjusts a parameter:
1. Log the change with reason
2. Queue a notification for user
3. Apply change immediately (or on next restart)

### Reporting Mechanism
```json
{
  "reporting": {
    "enabled": true,
    "channel": "telegram",
    "frequency": "on-change",  // "on-change" | "daily-summary" | "weekly-summary"
    "includeMetrics": true
  }
}
```

### Report Format
```
🧠 TRAM Auto-Tune Report

**Changed:** importanceThreshold 0.4 → 0.5
**Reason:** HOT tier exceeded target (62 > 50)
**Effect:** Fewer memories will auto-inject; higher quality threshold

**Current Stats:**
- HOT: 62 → expect ~45 after adjustment
- Token savings: ~500 tokens/turn estimated
```

### User Override
- User can revert via `/tram config importanceThreshold 0.4`
- Override locks parameter from auto-tuning for 7 days
- Can unlock: `/tram unlock importanceThreshold`

## Implementation Steps

1. Add tuning event queue
2. Implement notification formatter
3. Add channel delivery (reuse existing message infrastructure)
4. Add override/lock mechanism
5. Add unlock with TTL

## Success Criteria

- User notified of all auto-tuning changes
- User can easily revert unwanted changes
- Reports include enough context to understand impact
