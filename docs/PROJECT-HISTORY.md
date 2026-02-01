# Tiered Memory System: Overview

*Handed off to Ralph for implementation — 2026-01-30*

---

## Main Idea

Replace the flat LanceDB memory store with a **tiered system** that:
- Organizes memories by usage patterns (HOT/WARM/COLD/ARCHIVE)
- Automatically promotes/demotes based on access
- Injects relevant memories with tier-aware budgets

---

## The Tiers

| Tier | Contents | Lifespan | Behavior |
|------|----------|----------|----------|
| **HOT** | Recent captures, active context | 72 hours TTL | Always considered for injection |
| **WARM** | Frequently used, indexed | Days-weeks | Primary search target |
| **COLD** | Infrequently used | Months | Searched only when needed |
| **ARCHIVE** | Summarized/compacted | Permanent | Not auto-injected, explicit query only |

---

## Key Features

### 1. Memory Types
```
procedural  — How to do things (180-day half-life)
factual     — Facts about user/world (90-day half-life)
project     — Project-specific context (45-day half-life)
episodic    — What happened when (10-day half-life)
pinned      — Never decays, always injected
```

### 2. Automatic Tier Movement

**Demotion:**
- HOT → COLD after 72 hours
- WARM → COLD after 60 days unused

**Promotion:**
- COLD → WARM if accessed ≥3 times on ≥2 distinct days
- Never auto-promote to HOT (only explicit or new captures)

### 3. Scoring Formula
```
Score = 0.5 × similarity + 0.3 × recency + 0.2 × frequency
```
- Recency uses exponential decay with type-specific half-lives
- COLD tier memories get 0.5× score adjustment

### 4. Injection Budgets
When injecting memories into context:
```
Pinned: 25%
HOT:    45%
WARM:   25%
COLD:   5%
```
Max 20 memories total.

### 5. Soft Delete
- `memory_forget` sets `doNotInject = true` (soft delete)
- `memory_restore` clears the flag
- Hard delete only with explicit `--hard` flag

---

## Technology Stack

| Component | Technology |
|-----------|------------|
| Storage | SQLite (replacing LanceDB) |
| Full-text search | FTS5 |
| Vector search | sqlite-vec |
| Embeddings | OpenAI ada-002 (configurable) |

---

## New Schema

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  importance REAL DEFAULT 0.7,
  category TEXT DEFAULT 'other',
  created_at INTEGER NOT NULL,
  
  -- Tiering
  tier TEXT DEFAULT 'HOT',
  memory_type TEXT DEFAULT 'episodic',
  
  -- State
  do_not_inject INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0,
  
  -- Usage tracking
  last_accessed_at INTEGER,
  use_count INTEGER DEFAULT 0,
  use_days TEXT DEFAULT '[]',  -- JSON array of ISO dates
  
  -- Provenance
  source TEXT DEFAULT 'auto-capture',
  parent_id TEXT  -- For summarized/compacted memories
);
```

---

## Tools (Agent-Facing)

| Tool | Purpose |
|------|---------|
| `memory_recall` | Search with tier filtering |
| `memory_store` | Store with tier/type assignment |
| `memory_forget` | Soft delete |
| `memory_restore` | Undo soft delete |
| `memory_pin` | Mark as always-inject |
| `memory_unpin` | Remove pin |
| `memory_promote` | Move to higher tier |
| `memory_demote` | Move to lower tier |
| `memory_explain` | Show scoring breakdown |

---

## CLI Commands

```
openclaw memory search <query> [--tier <tier>] [--deep]
openclaw memory list [--tier <tier>]
openclaw memory forget <id> [--hard]
openclaw memory restore <id>
openclaw memory pin <id>
openclaw memory unpin <id>
openclaw memory promote <id> [tier]
openclaw memory demote <id> <tier>
openclaw memory stats
openclaw memory explain <id>
openclaw memory archive [--older-than <time>] [--preview]
openclaw memory export [--format json|sqlite]
```

---

## Hooks

### `before_agent_start` — Auto-injection
1. Extract key terms from prompt
2. Hybrid search (FTS + vector)
3. Score and rank using formula
4. Apply tier budgets
5. Update access timestamps
6. Inject formatted context

### `agent_end` — Auto-capture
1. Extract capturable content from conversation
2. Detect memory type
3. Store in HOT tier
4. Generate embeddings

---

## Background Service

Runs every 6 hours:
1. Demote HOT memories past TTL → COLD
2. Demote unused WARM memories → COLD
3. Check COLD promotion eligibility
4. Summarize old COLD clusters → ARCHIVE

---

## Migration Path

1. **Phase 1A:** Extend schema (non-breaking)
2. **Phase 1B:** Migrate LanceDB → SQLite
3. **Phase 2:** Index existing workspace files (MEMORY.md, memory/*.md)

---

## Relationship to Auto-Fetch Research

The tiered memory system is **Layer 0** — storage infrastructure.

HAMR (auto-fetch research) builds on top:
```
Layer 0: Tiered Memory (Ralph's plugin)  ← This system
Layer 1: Basic Auto-Fetch
Layer 2: Hybrid Retrieval
Layer 3: Smart Scoring (ACT-R features)
Layer 4: Query Enhancement (HyDE)
Layer 5: Feedback Loop
Layer 6: Graph/Linking
```

The tiered storage provides:
- HOT/WARM/COLD tiers
- Usage tracking (access times, counts)
- Type classification
- Scoring formula foundation

HAMR adds:
- Automatic fetch every turn
- Memory gating (inject/summarize/discard)
- Bi-temporal reasoning
- Learnable scoring
- Feedback-based improvement

---

## Status

- **PRD:** Completed 2026-01-30
- **Implementation:** Handed to Ralph
- **Decisions made:** 1A+1C, 2C, 3D, 4C, 5A

---

*Full integration guide: `docs/tiered-memory-integration-guide.md`*
