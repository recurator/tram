# Issue 016: Hybrid "Useful" Metric for Memory Quality

**Status:** Backlog
**Priority:** Medium
**Created:** 2026-02-02

## Summary

Define and track what makes an injected memory "useful" using both automated proxy metrics and periodic agent self-evaluation.

## Design

### TRAM-Level Proxy Metrics (Automatic)
Track for each injection:
- **Access frequency**: Was this memory accessed again soon after?
- **Session outcome**: Did the session complete successfully?
- **Injection density**: How many memories were injected vs. context size?
- **Decay resistance**: Did this memory get promoted or demoted after injection?

Composite score: `useful_score = f(access_freq, outcome, density, resistance)`

### Bot-Level Qualitative Review (Weekly)
During Friday review, agent evaluates:
- "Were injected memories helpful this week? 1-5"
- "Any memories that kept appearing but weren't useful?"
- "Any important context that was missing?"

Store evaluations as feedback signal.

### Feedback Loop
- High useful_score → slower decay, higher injection priority
- Low useful_score → faster decay, lower priority
- Agent feedback overrides proxy metrics when explicit

## Data Model

```sql
CREATE TABLE injection_feedback (
  id TEXT PRIMARY KEY,
  memory_id TEXT,
  session_key TEXT,
  injected_at INTEGER,
  proxy_score REAL,        -- automated
  agent_score INTEGER,     -- 1-5, nullable
  agent_notes TEXT,
  created_at INTEGER
);
```

## Open Questions

- How to detect "session completed successfully"?
- Should negative feedback trigger immediate demotion?
- How much weight to give agent feedback vs. proxy metrics?

## Dependencies

- Issue 015: Hybrid Tuning System
- Weekly review infrastructure
