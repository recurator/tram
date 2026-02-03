# Issue #019: Auto-Recall Min Score Threshold + Config Exposure

**Priority:** 🔴 URGENT (Phase 1)  
**Type:** Bug/Missing Feature  
**Component:** Auto-Recall Hook, Config Schema  
**Created:** 2026-02-02  
**Blocks:** All tuning features (#014-#018)

## Problem

Two related issues blocking TRAM tuning:

### 1. No Minimum Score Threshold
Auto-recall injects memories based purely on **rank** (top N per tier), with no minimum relevance cutoff. This causes irrelevant memories to pollute context when:

- Few memories exist (system fills budget with whatever's available)
- Query terms are generic (low semantic similarity across the board)
- HOT tier memories score high on recency/frequency despite being irrelevant

**Current behavior:**
```
candidate pool (60) → tier budget allocation → top N selected
                      ↑ no filtering here!
```

**Example:** User asks about "config thresholds" → gets injected with "Moltbook drama" and "test memory Alpha" because they're HOT and recent.

### 2. Config Settings Not Exposed to OpenClaw
TRAM has internal config for `injection`, `scoring`, `tiers`, `decay` — but these aren't in the OpenClaw config schema. Users cannot tune via `openclaw.json`:

**Internal (exists but hidden):**
```typescript
injection: { maxItems, budgets }
scoring: { similarity, recency, frequency }
tiers: { hot.ttlHours, warm.demotionDays, cold.promotionUses }
decay: { intervalHours }
```

**Exposed (only these):**
```json
{ "embedding": {}, "dbPath": "", "autoCapture": bool, "autoRecall": bool }
```

## Proposed Solution

### Part A: Add minScore Threshold

```javascript
// In auto_recall.js execute()
const scored = hybridResults.map(r => ({
  ...r,
  composite: this.scorer.score(memory, r.vectorScore)
}));

const filtered = scored.filter(r => r.composite >= this.config.minScore);
// Then proceed with tier allocation on filtered set
```

### Part B: Expose Full Config Schema

Update `MemoryTieredConfigSchema` registration to expose all settings:

```json
{
  "plugins": {
    "entries": {
      "tram": {
        "config": {
          "embedding": { "provider": "local" },
          "autoCapture": true,
          "autoRecall": true,
          "injection": {
            "maxItems": 10,
            "minScore": 0.25,
            "budgets": { "pinned": 25, "hot": 45, "warm": 25, "cold": 5 }
          },
          "scoring": {
            "similarity": 0.6,
            "recency": 0.25,
            "frequency": 0.15
          },
          "tiers": {
            "hot": { "ttlHours": 72 },
            "warm": { "demotionDays": 60 },
            "cold": { "promotionUses": 3, "promotionDays": 2 }
          },
          "decay": { "intervalHours": 6 }
        }
      }
    }
  }
}
```

## Implementation Steps

1. Add `minScore` to `InjectionConfigSchema` (default: 0.2)
2. Update `auto_recall.js` to filter by minScore before tier allocation
3. Expose full config schema in plugin registration (index.ts)
4. Add UI hints for all new fields
5. Test backward compatibility (bool `autoRecall: true` still works)

## Acceptance Criteria

- [ ] `injection.minScore` config option added and functional
- [ ] Candidates below threshold excluded before tier allocation
- [ ] Empty injection handled gracefully (no crash, no forced fill)
- [ ] All TRAM config settings exposed to OpenClaw gateway
- [ ] UI hints added for config UI
- [ ] Backward compatibility with simple `autoRecall: true`
- [ ] Documentation updated

## Related Issues

- **Supersedes:** Old #012 (Expose Auto-Recall Tuning Config)
- **Unblocks:** #021, #022, #023, #024, #025 (all tuning features)
- **Refs:** HAMR Framework INJECT/PROBE/DISCARD gating
