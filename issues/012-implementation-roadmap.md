# TRAM v0.2.0 Implementation Roadmap

**Plugin:** TRAM (Tiered Reversible Associative Memory)  
**Version:** v0.1.0 → v0.2.0  
**Maintainer:** Colin  
**Last Updated:** 2026-02-02

---

## Overview

This roadmap tracks enhancements to TRAM's auto-recall tuning, observability, and memory management. Issues are ordered by implementation priority and dependencies.

## Implementation Order

### Phase 1: Foundation (Urgent)

| # | Issue | Status | Description |
|---|-------|--------|-------------|
| **020** | [Min Score Threshold + Config Exposure](020-auto-recall-min-score-threshold.md) | 🔴 TODO | Add `minScore` filter, expose all config settings to OpenClaw. **Blocks all other issues.** |

### Phase 2: Observability

| # | Issue | Status | Description |
|---|-------|--------|-------------|
| **021** | [Useful Metric (Hybrid)](021-useful-metric-hybrid.md) | ⬜ TODO | Track injection usefulness via feedback signals. Required for informed tuning. |

### Phase 3: Tuning Knobs

| # | Issue | Status | Description |
|---|-------|--------|-------------|
| **022** | [Decay Tuning Per Category](022-decay-tuning-per-category.md) | ⬜ TODO | Different decay rates for different memory types (procedural vs episodic). |
| **023** | [Hybrid Tuning System](023-hybrid-tuning-system.md) | ⬜ TODO | Unified tuning interface for all parameters with presets. |

### Phase 4: Automation

| # | Issue | Status | Description |
|---|-------|--------|-------------|
| **024** | [Auto-Tuning with Reporting](024-auto-tuning-with-reporting.md) | ⬜ TODO | Automatic parameter adjustment based on #021 metrics. |

### Phase 5: Architecture

| # | Issue | Status | Description |
|---|-------|--------|-------------|
| **025** | [Session Tier Separation](025-session-tier-separation.md) | ⬜ TODO | Isolate session-specific memories from long-term store. |

---

## Dependency Graph

```
#020 (minScore + config)
  │
  ├──► #021 (metrics)
  │      │
  │      └──► #024 (auto-tuning)
  │
  ├──► #022 (decay per category)
  │      │
  │      └──► #023 (hybrid tuning)
  │
  └──► #025 (session tiers) [independent]
```

## Resolved Issues

| # | Issue | Resolution |
|---|-------|------------|
| 001 | Short ID Matching | ✅ Resolved |
| 002 | Auto-Capture Noise Filters | ✅ Resolved |
| 003 | OpenClaw Plugin API Alignment | ✅ Resolved |
| 004 | Build for OpenClaw Deployment | ✅ Resolved |
| 005 | FTS5 Query Bug | ✅ Resolved |
| 006 | Critical Plugin API Misalignment | ✅ Resolved |
| 008 | Auto-Recall Not Injecting | ✅ Resolved |
| 010 | SQLite Disk I/O Error | ✅ Resolved |
| 011 | CLI Commands Not Registering | ✅ Resolved |

## Other Open Issues

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| **013** | [Tool Naming Convention](013-investigate-tool-naming-convention.md) | ⬜ TODO | Investigate `memory_*` vs `tram_*` naming |

---

## Version Targets

### v0.1.1 (Patch)
- #019: minScore threshold + config exposure

### v0.2.0 (Minor)
- #016: Usefulness metrics
- #014: Decay per category
- #015: Hybrid tuning system

### v0.3.0 (Minor)
- #017: Auto-tuning
- #018: Session tier separation

---

*This file supersedes the original #012 (Expose Auto-Recall Tuning Config), which is now merged into #019.*
