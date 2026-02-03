# Issue 014: Decay Tuning per Category

**Status:** Icebox
**Priority:** Low
**Created:** 2026-02-02

## Summary

Allow different decay rates for different memory categories/types.

## Use Case

- Factual memories (preferences, facts about user) should decay slowly
- Episodic memories (what happened today) should decay faster
- Procedural memories (how to do things) should be sticky
- Project context should decay when project ends

## Proposed API

```json
{
  "decay": {
    "default": { "hotTTL": 72, "warmTTL": 336 },
    "overrides": {
      "factual": { "hotTTL": 168, "warmTTL": 720 },
      "episodic": { "hotTTL": 48, "warmTTL": 168 },
      "procedural": { "hotTTL": null, "warmTTL": null }  // no decay
    }
  }
}
```

## Open Questions

- Should categories be user-defined or fixed typology?
- How to handle memories with multiple categories?
- Should decay rate be configurable at store-time?

## Dependencies

- Requires memory_type field to be consistently populated
