# Issue 015: Hybrid Tuning System

**Status:** Backlog
**Priority:** High
**Created:** 2026-02-02

## Summary

Implement hybrid tuning where TRAM auto-adjusts thresholds based on heuristics, and the agent reviews/overrides via weekly review.

## Design

### TRAM-Level (Automatic)
- Track tier sizes over time
- Auto-adjust importance threshold when HOT grows too large (>50) or too small (<5)
- Auto-adjust decay rates based on access patterns
- Log all adjustments with timestamp and reason

### Bot-Level (Weekly Review)
- `memory_stats` tool provides current config + metrics
- Agent reviews during Friday weekly review
- Agent can override via config patch
- Changes reported to user

### Tuning Parameters
```json
{
  "tuning": {
    "enabled": true,
    "mode": "hybrid",  // "auto" | "manual" | "hybrid"
    "autoAdjust": {
      "importanceThreshold": { "min": 0.3, "max": 0.7, "step": 0.05 },
      "hotTargetSize": { "min": 10, "max": 30 },
      "warmTargetSize": { "min": 50, "max": 150 }
    },
    "reportChanges": true,
    "reportChannel": "telegram"
  }
}
```

## Implementation Steps

1. Add `memory_stats` tool (read-only stats + current config)
2. Add tuning log table (timestamp, param, old_value, new_value, reason)
3. Implement auto-adjustment logic in decay service
4. Add config options for tuning behavior
5. Integrate with weekly review cron

## Dependencies

- Issue 012: Expose auto-recall tuning config
- Nightly/weekly review infrastructure

## Success Criteria

- HOT tier stays within target range without manual intervention
- All adjustments logged and reported
- Agent can review and override via tools
