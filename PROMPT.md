# PRD: Tiered Local Memory System with Reversible Forgetting

## Overview

**Problem:** The current OpenClaw memory system (`memory-lancedb`) is a single-tier, flat store where all memories are treated equally regardless of age, importance, or usage patterns. This causes context pollution with stale memories, no way to "forget" without permanent deletion, and requires cloud connectivity (OpenAI embeddings).

**Solution:** A tiered local memory system with four logical tiers (HOT, WARM, COLD, ARCHIVE), reversible forgetting via soft-delete flag, and composite scoring (similarity + recency + frequency). Uses SQLite + FTS5 + sqlite-vec for fully offline operation.

**Business Value:** Improves context relevance dramatically, enables GDPR-compliant "right to be forgotten" without data loss, and supports fully offline operation.

**Complexity:** XL - 15+ files, new SQLite schema, 9 tools, 15 CLI commands, background services, migration path

---

## Goals

- Implement 4-tier memory system (HOT, WARM, COLD, ARCHIVE) with distinct injection priorities
- Enable reversible forgetting that excludes memories from injection without deletion
- Implement composite scoring: `w_sim × similarity + w_rec × exp(-age/half_life) + w_freq × log(1 + use_count)`
- Support fully offline operation with local embeddings (configurable cloud fallback)
- Provide token-budget-based injection with configurable tier allocations
- Implement automatic decay (HOT→COLD) and promotion (COLD→WARM) based on usage
- Maintain backwards compatibility with existing memory files
- Define Phase 2 extension points without implementing them

---

## Target Users

| User Type | Context | Discovery |
|-----------|---------|-----------|
| Power Users | Heavy OpenClaw users with 100+ memories | Plugin settings, `memory stats` |
| Privacy-Conscious | Need to "forget" without permanent deletion | `memory forget`, tools |
| Offline Users | Air-gapped or limited connectivity | Config switch to local embeddings |
| Developers | Building on OpenClaw, need inspectable behavior | `memory explain`, audit |
| Migrating Users | Existing memory-lancedb users | Migration wizard |

---

## Requirements (MoSCoW)

### Must Have (Launch Blockers)
- FR-1: SQLite database with tiered schema (tier, memory_type, do_not_inject, pinned, use_count, last_accessed_at)
- FR-2: FTS5 full-text search integration
- FR-3: sqlite-vec vector search with in-process cosine fallback
- FR-4: Configurable embedding providers (local default, optional OpenAI/Gemini)
- FR-5: Composite scoring formula with configurable weights
- FR-6: Tier budget injection: pinned (25%), HOT (45%), WARM (25%), COLD (5%)
- FR-7: Reversible forgetting via `do_not_inject` flag
- FR-8: Pin/unpin to bypass decay
- FR-9: `before_agent_start` hook for proactive injection
- FR-10: `agent_end` hook for auto-capture (always HOT tier)
- FR-11: CLI: search, forget, restore, pin, unpin, list, stats, explain
- FR-12: Tools: memory_recall, memory_store, memory_forget, memory_restore, memory_pin, memory_explain
- FR-13: Current-context slot: single record, always injected, 4hr TTL
- FR-14: Legacy file indexing: MEMORY.md → WARM, memory/*.md → HOT
- FR-15: Supersede memory-lancedb as new default

### Should Have (High Value)
- FR-16: Background decay service (HOT past 72hr → COLD)
- FR-17: Promotion rules (COLD with ≥3 uses over ≥2 days → WARM)
- FR-18: LanceDB → SQLite migration command
- FR-19: CLI: promote, demote, archive, audit, export
- FR-20: Bulk operations with `--preview` flag
- FR-21: Memory type classification with configurable half-lives
- FR-22: Write-through semantics (immediate persistence)

### Could Have (Nice to Have)
- FR-23: Hard delete with confirmation (`memory destroy`)
- FR-24: COLD cluster summarization → ARCHIVE
- FR-25: Embedding model version tracking and re-embedding
- FR-26: Documentation website (separate repo)

### Won't Have (Phase 2 / Out of Scope)
- Structured entity layer with relationships
- Entity auto-load on mention detection
- Meta-memory (design docs, PRDs as special type)
- Adaptive decay per project/domain
- Semantic deduplication
- Cloud sync service

---

## User Stories

### US-001: SQLite Schema with Tiering
**Priority:** Must Have
**Description:** As a developer, I need the database schema to support tiered memory storage so memories can be organized by injection priority.

**Acceptance Criteria:**
- [ ] Create `memories` table: id (TEXT PK), text (TEXT NOT NULL), importance (REAL), category (TEXT), created_at (INTEGER), tier (TEXT CHECK HOT/WARM/COLD/ARCHIVE), memory_type (TEXT), do_not_inject (INTEGER DEFAULT 0), pinned (INTEGER DEFAULT 0), use_count (INTEGER DEFAULT 0), last_accessed_at (INTEGER), use_days (TEXT JSON), source (TEXT), parent_id (TEXT FK)
- [ ] Create `memories_fts` virtual table using FTS5
- [ ] Create triggers to keep FTS in sync (INSERT, UPDATE, DELETE)
- [ ] Create `current_context` table (id, text, created_at, ttl_seconds)
- [ ] Create `memory_audit` table for action logging
- [ ] Add indexes on tier, do_not_inject, pinned, last_accessed_at
- [ ] Unit tests verify schema creation and constraints

### US-002: Vector Search with sqlite-vec
**Priority:** Must Have
**Description:** As a user, I want vector similarity search so semantically related memories are found.

**Acceptance Criteria:**
- [ ] Load sqlite-vec extension safely with try/catch
- [ ] Create vec0 virtual table for embeddings
- [ ] Implement `hybridSearch()` combining FTS5 BM25 + vector similarity
- [ ] Configurable weights: vector (0.7), text (0.3)
- [ ] Fallback to in-process cosine when sqlite-vec unavailable
- [ ] Search completes in <100ms for 10k memories
- [ ] Unit tests for vector search and fallback

### US-003: Configurable Embedding Providers
**Priority:** Must Have
**Description:** As a user, I want to choose my embedding provider for offline or cloud operation.

**Acceptance Criteria:**
- [ ] Config: `embedding.provider` = "local" | "openai" | "gemini" | "auto"
- [ ] "local" uses transformers.js or ONNX runtime
- [ ] "openai" uses text-embedding-3-small (requires apiKey)
- [ ] "gemini" uses Gemini embedding (requires apiKey)
- [ ] "auto" tries local first, falls back to cloud
- [ ] Track embedding dimensions per provider/model
- [ ] Graceful error handling if provider unavailable

### US-004: Composite Memory Scoring
**Priority:** Must Have
**Description:** As a user, I want memories ranked by relevance, recency, and usage.

**Acceptance Criteria:**
- [ ] Implement `MemoryScorer` class with configurable weights
- [ ] Formula: `score = w_sim × similarity + w_rec × exp(-effective_age / half_life) + w_freq × log(1 + use_count)`
- [ ] Effective age = `now - max(created_at, last_accessed_at)`
- [ ] Half-lives: procedural (180d), factual (90d), project (45d), episodic (10d), pinned (∞)
- [ ] Tier adjustments: COLD recency × 0.5, ARCHIVE score = 0
- [ ] Default weights: similarity (0.5), recency (0.3), frequency (0.2)
- [ ] Unit tests verify formula correctness

### US-005: Tier Budget Injection
**Priority:** Must Have
**Description:** As a user, I want HOT/WARM memories prioritized in injection.

**Acceptance Criteria:**
- [ ] Configurable `injection.maxItems` (default 20)
- [ ] Budgets: pinned (25%), HOT (45%), WARM (25%), COLD (5%)
- [ ] ARCHIVE never auto-injected
- [ ] Exclude `do_not_inject = true` memories
- [ ] Fill buckets by score within tier
- [ ] Unit tests verify budget allocation

### US-006: Reversible Forgetting
**Priority:** Must Have
**Description:** As a user, I want to "forget" memories without permanent deletion.

**Acceptance Criteria:**
- [ ] `memory_forget` tool sets `do_not_inject = true`
- [ ] Forgotten memories excluded from injection but searchable
- [ ] CLI `memory forget <id|query>` with confirmation
- [ ] CLI `memory forget --hard` for permanent deletion (requires --confirm)
- [ ] Audit log entry on forget action
- [ ] Unit tests verify soft-delete behavior

### US-007: Memory Restore
**Priority:** Must Have
**Description:** As a user, I want to restore forgotten memories.

**Acceptance Criteria:**
- [ ] `memory_restore` tool clears `do_not_inject` flag
- [ ] CLI `memory restore <id>`
- [ ] Audit log entry on restore
- [ ] Error if not found or not forgotten

### US-008: Pin/Unpin Memories
**Priority:** Must Have
**Description:** As a user, I want to pin important memories to bypass decay.

**Acceptance Criteria:**
- [ ] `memory_pin` sets `pinned = true`, defaults to WARM tier
- [ ] Pinned memories bypass decay, get 25% injection budget
- [ ] CLI `memory pin <id>` and `memory unpin <id>`
- [ ] Show [PINNED] tag in list/search
- [ ] Unit tests verify pinned bypass decay

### US-009: Auto-Recall Hook
**Priority:** Must Have
**Description:** As a user, I want relevant memories automatically injected.

**Acceptance Criteria:**
- [ ] Register `before_agent_start` hook
- [ ] Extract key terms from prompt
- [ ] Hybrid search (FTS + vector)
- [ ] Apply MemoryScorer ranking
- [ ] Apply tier budgets
- [ ] Update `last_accessed_at` and `use_count`
- [ ] Track distinct days in `use_days`
- [ ] Format as `<relevant-memories>...</relevant-memories>`
- [ ] Configurable via `autoRecall` (default true)

### US-010: Auto-Capture Hook
**Priority:** Must Have
**Description:** As a user, I want important info auto-captured from conversations.

**Acceptance Criteria:**
- [ ] Register `agent_end` hook
- [ ] Extract capturable text (length 10-500, trigger patterns)
- [ ] Detect memory_type from content
- [ ] Store with `tier = 'HOT'`, `source = 'auto-capture'`
- [ ] Check duplicates (similarity > 0.95)
- [ ] Limit 3 captures per conversation
- [ ] Configurable via `autoCapture` (default true)

### US-011: Current-Context Slot
**Priority:** Must Have
**Description:** As a user, I want to set active task context always injected.

**Acceptance Criteria:**
- [ ] Separate `current_context` table (not in memories)
- [ ] Single active record (id = 'active')
- [ ] Always injected at top of context
- [ ] Default TTL: 4 hours (configurable)
- [ ] CLI `memory set-context <text>` and `memory clear-context`
- [ ] Tools `memory_set_context` and `memory_clear_context`
- [ ] Auto-clear on TTL expiry (lazy deletion)

### US-012: CLI Search Command
**Priority:** Must Have
**Description:** As a user, I want to search memories from CLI.

**Acceptance Criteria:**
- [ ] `openclaw memory search <query>`
- [ ] `--deep` includes ARCHIVE
- [ ] `--tier <tier>` filters
- [ ] `--limit <n>` (default 10)
- [ ] Output: id, text, tier, score, [PINNED], [FORGOTTEN] tags
- [ ] `--json` for JSON output
- [ ] `--explain` for scoring breakdown

### US-013: CLI List Command
**Priority:** Must Have
**Description:** As a user, I want to list memories by tier.

**Acceptance Criteria:**
- [ ] `openclaw memory list` shows counts by tier
- [ ] `--tier <tier>` shows memories in tier
- [ ] `--forgotten` shows forgotten only
- [ ] `--pinned` shows pinned only
- [ ] `--sort <field>` (created_at, last_accessed_at, use_count)

### US-014: CLI Stats Command
**Priority:** Must Have
**Description:** As a user, I want memory statistics.

**Acceptance Criteria:**
- [ ] Show totals by tier
- [ ] Show forgotten/pinned counts
- [ ] Show memory types distribution
- [ ] Show DB file size
- [ ] Show current context status
- [ ] Show embedding provider/model
- [ ] Show last decay run timestamp

### US-015: CLI Explain Command
**Priority:** Must Have
**Description:** As a user, I want to understand memory scoring.

**Acceptance Criteria:**
- [ ] `openclaw memory explain <id>`
- [ ] `--query <query>` for similarity calculation
- [ ] Show full text, tier, memory_type
- [ ] Show timestamps and effective age
- [ ] Show use_count and use_days
- [ ] Show scoring breakdown
- [ ] Show injection eligibility with reason

### US-016: Legacy File Indexing
**Priority:** Must Have
**Description:** As a user, I want existing memory files indexed.

**Acceptance Criteria:**
- [ ] Detect MEMORY.md, index as WARM
- [ ] Detect memory/*.md, index as HOT
- [ ] Chunk files, generate embeddings
- [ ] Track file hash to skip indexed
- [ ] CLI `memory index` to re-index
- [ ] `--force` to re-index all

### US-017: Background Decay Service
**Priority:** Should Have
**Description:** As a user, I want memories to decay automatically.

**Acceptance Criteria:**
- [ ] Register background service
- [ ] Run every 6 hours (configurable)
- [ ] HOT past 72hr → COLD
- [ ] WARM unused > 60 days → COLD
- [ ] Skip pinned memories
- [ ] CLI `memory decay run` for manual trigger
- [ ] Store last_decay_run in meta

### US-018: Promotion Rules
**Priority:** Should Have
**Description:** As a user, I want frequently-used COLD memories promoted.

**Acceptance Criteria:**
- [ ] COLD with ≥3 uses over ≥2 days → WARM
- [ ] Configurable thresholds
- [ ] Check during decay cycle
- [ ] Never auto-promote to HOT
- [ ] Audit log promotions

### US-019: LanceDB Migration
**Priority:** Should Have
**Description:** As existing user, I want to migrate my LanceDB data.

**Acceptance Criteria:**
- [ ] CLI `memory migrate --from lancedb`
- [ ] Detect LanceDB at ~/.openclaw/memory/lancedb
- [ ] Export entries with vectors
- [ ] Import as WARM, source = 'legacy'
- [ ] `--preview` shows plan
- [ ] `--rollback` restores LanceDB
- [ ] Progress bar for large migrations

### US-020: Plugin Configuration
**Priority:** Must Have
**Description:** As a user, I want to configure the plugin.

**Acceptance Criteria:**
- [ ] `embedding.provider`: "local" | "openai" | "gemini" | "auto"
- [ ] `embedding.apiKey`, `embedding.model`, `embedding.local.modelPath`
- [ ] `dbPath` (default ~/.openclaw/memory/tiered.db)
- [ ] `autoCapture`, `autoRecall` booleans
- [ ] `tiers.hot.ttlHours`, `tiers.warm.demotionDays`, `tiers.cold.promotionUses/Days`
- [ ] `scoring.similarity/recency/frequency` weights
- [ ] `injection.maxItems`, `injection.budgets`
- [ ] `decay.intervalHours`, `context.ttlHours`
- [ ] UI hints for all fields

### US-021: Phase 2 Extension Points
**Priority:** Must Have
**Description:** As a developer, I want extension points for Phase 2.

**Acceptance Criteria:**
- [ ] Schema includes nullable Phase 2 columns (entity_refs, meta_type)
- [ ] Define `EntityExtractor` interface
- [ ] Define `MemoryCompactor` interface
- [ ] Define `SemanticDeduplicator` interface
- [ ] Document extension points in code

### US-022: Deprecate memory-lancedb
**Priority:** Must Have
**Description:** As maintainer, I want memory-tiered as new default.

**Acceptance Criteria:**
- [ ] Add deprecation notice to memory-lancedb
- [ ] Update default memory slot to 'memory-tiered'
- [ ] Add migration prompt on first run
- [ ] Update documentation
- [ ] Announce deprecation timeline

---

## Data Model

### New Tables

#### `memories`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PK | UUID primary key |
| text | TEXT | NOT NULL | Memory content |
| importance | REAL | DEFAULT 0.7 | Legacy importance |
| category | TEXT | DEFAULT 'other' | Legacy category |
| created_at | INTEGER | NOT NULL | Unix timestamp ms |
| tier | TEXT | DEFAULT 'HOT', CHECK | HOT/WARM/COLD/ARCHIVE |
| memory_type | TEXT | DEFAULT 'episodic' | Decay half-life control |
| do_not_inject | INTEGER | DEFAULT 0 | Soft-delete flag |
| pinned | INTEGER | DEFAULT 0 | Bypass decay |
| use_count | INTEGER | DEFAULT 0 | Access count |
| last_accessed_at | INTEGER | NULL | Last access timestamp |
| use_days | TEXT | DEFAULT '[]' | JSON array ISO dates |
| source | TEXT | DEFAULT 'auto-capture' | Provenance |
| parent_id | TEXT | FK, NULL | For compaction |
| entity_refs | TEXT | NULL | Phase 2 |
| meta_type | TEXT | NULL | Phase 2 |

**Indexes:**
- `idx_memories_tier`
- `idx_memories_do_not_inject`
- `idx_memories_pinned`
- `idx_memories_last_accessed`

#### `current_context`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PK | Always 'active' |
| text | TEXT | NOT NULL | Context content |
| created_at | INTEGER | NOT NULL | Timestamp |
| ttl_seconds | INTEGER | DEFAULT 14400 | 4 hours |

#### `memory_audit`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PK | UUID |
| memory_id | TEXT | NOT NULL | Referenced memory |
| action | TEXT | NOT NULL | forget/restore/pin/etc |
| old_value | TEXT | NULL | Previous state JSON |
| new_value | TEXT | NULL | New state JSON |
| created_at | INTEGER | NOT NULL | Timestamp |

---

## API Contracts (Tools)

### memory_recall
- **Parameters:** query (required), limit (default 5), tier (filter), includeArchive, includeForgotten
- **Returns:** List of memories with id, text, tier, memory_type, score, pinned, forgotten flags

### memory_store
- **Parameters:** text (required), tier (optional HOT/WARM), memory_type (optional), importance (0-1), pinned
- **Returns:** Created memory details OR duplicate warning with existing ID

### memory_forget
- **Parameters:** query OR memoryId, hard (for permanent deletion)
- **Returns:** Confirmation with restorable flag

### memory_restore
- **Parameters:** memoryId (required)
- **Returns:** Confirmation

### memory_pin / memory_unpin
- **Parameters:** memoryId (required)
- **Returns:** Confirmation

### memory_explain
- **Parameters:** memoryId (required), query (optional for similarity)
- **Returns:** Full memory details, scoring breakdown (similarity, recency, frequency components), injection eligibility

### memory_set_context / memory_clear_context
- **Parameters (set):** text (required), ttlHours (default 4)
- **Returns:** Confirmation with expiry timestamp

---

## File Structure

```
extensions/memory-tiered/
├── index.ts                    # Plugin entry point
├── config.ts                   # Config schema + validation
├── package.json                # npm manifest
├── openclaw.plugin.json        # Plugin metadata
├── db/
│   ├── sqlite.ts               # SQLite wrapper + schema
│   ├── fts.ts                  # FTS5 helpers
│   ├── vectors.ts              # sqlite-vec + fallback
│   └── migrations.ts           # Schema upgrades
├── core/
│   ├── types.ts                # Type definitions
│   ├── scorer.ts               # MemoryScorer class
│   ├── decay.ts                # DecayEngine
│   ├── promotion.ts            # Promotion rules
│   └── injection.ts            # Tier budget allocation
├── embeddings/
│   ├── provider.ts             # Interface
│   ├── local.ts                # Local embeddings
│   ├── openai.ts               # OpenAI embeddings
│   └── gemini.ts               # Gemini embeddings
├── tools/                      # Tool implementations
├── cli/                        # CLI commands
├── hooks/                      # Lifecycle hooks
├── migration/                  # LanceDB + file migration
└── __tests__/                  # Tests
```

---

## Edge Cases & Error Handling

| Scenario | Expected Behavior |
|----------|-------------------|
| Search with no results | Empty array, "No relevant memories found" |
| Store duplicate (>95% similarity) | Return existing ID, "Similar memory exists" |
| Forget already-forgotten | No-op, "Already forgotten" |
| Restore non-forgotten | No-op, "Not forgotten" |
| sqlite-vec not found | Fallback to cosine, log warning |
| Local embedding model missing | Error with config suggestion |
| Invalid memory ID | "Invalid memory ID format" |
| Memory not found | "Memory not found: {id}" |
| DB locked | Retry with backoff, fail after 3 attempts |
| Context TTL expired | Clear on next access |

---

## Security & Permissions

- Plugin inherits OpenClaw authentication
- All operations scoped to current user/agent
- API keys stored via OpenClaw credential system
- DB file permissions: 600 (user read/write only)
- SQL injection: parameterized queries only
- Input validation: UUID format, text length 10-10000, enum constraints

---

## Technical Considerations

- **Dependencies:** node:sqlite (Node 22+), optional sqlite-vec, transformers.js/onnxruntime, openai SDK
- **Storage:** ~/.openclaw/memory/tiered.db, ~1KB per entry + embedding
- **Performance:** Search <100ms for 10k memories, store <500ms
- **Concurrency:** SQLite WAL mode, write transactions serialized
- **Integration:** Study `extensions/memory-lancedb/` for plugin patterns

---

## Plugin Integration Specification

This section provides the exact integration requirements for OpenClaw plugins.

### Plugin Definition Requirements

The plugin module MUST export a default object with these properties:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | string | Yes | Unique plugin ID: `"memory-tiered"` |
| `name` | string | Yes | Display name: `"Memory (Tiered)"` |
| `description` | string | Yes | Brief description |
| `kind` | `"memory"` | Yes | **CRITICAL:** Must be `"memory"` to use the memory slot system |
| `configSchema` | object | Yes | Config schema with `parse()` and `uiHints` |
| `register` | function | Yes | Registration function receiving `OpenClawPluginApi` |

### Config Schema Pattern

The `configSchema` object MUST have:

| Property | Type | Description |
|----------|------|-------------|
| `parse(value)` | function | Validates and transforms raw config; throws on invalid |
| `uiHints` | object | UI hints per config field (label, help, sensitive, advanced, placeholder) |

### Plugin API Methods to Use

| Method | Purpose |
|--------|---------|
| `api.registerTool(tool, opts)` | Register agent tools with `{ name: "tool_name" }` |
| `api.on(hookName, handler)` | Register lifecycle hooks (`before_agent_start`, `agent_end`) |
| `api.registerCli(registrar, opts)` | Register CLI commands with `{ commands: ["memory"] }` |
| `api.registerService(service)` | Register background services (decay engine) |
| `api.resolvePath(path)` | Resolve `~/.openclaw/...` paths |
| `api.logger` | Plugin logger (info, warn, error, debug) |
| `api.pluginConfig` | Raw config passed to plugin |

### Tool Response Format

All tools MUST return this exact structure:

```
{
  content: [{ type: "text", text: "<human readable message>" }],
  details: { <structured data for programmatic use> }
}
```

### Hook Signatures

**before_agent_start:**
- Input: `{ prompt: string, messages?: unknown[] }`
- Return: `{ prependContext?: string, systemPrompt?: string }` or void

**agent_end:**
- Input: `{ messages: unknown[], success: boolean, error?: string }`
- Return: void

### Import Pattern

```
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
```

### Memory Injection Format

Auto-recalled memories MUST be formatted as:

```
<relevant-memories>
The following memories may be relevant:
- [category] memory text (score%)
</relevant-memories>
```

### Service Registration (Decay Engine)

Background services for decay must be registered with:

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Service ID: `"memory-tiered-decay"` |
| `start(ctx)` | function | Called on gateway start; ctx has config, logger, stateDir |
| `stop(ctx)` | function | Called on gateway stop for cleanup |

The decay service should:
- Schedule interval-based runs (setInterval with configurable hours)
- Check `last_decay_run` in DB to avoid duplicate runs
- Process HOT→COLD demotions and COLD→WARM promotions
- Update `last_decay_run` timestamp after completion

### CLI Command Registration

CLI commands are registered under a parent command:

```
api.registerCli(({ program }) => {
  const memory = program.command("memory").description("...");
  memory.command("search").argument("<query>").action(...);
}, { commands: ["memory"] });
```

The `{ commands: ["memory"] }` option declares command names for routing.

---

### Package Manifest Requirements

**package.json** must include:

| Field | Value | Purpose |
|-------|-------|---------|
| `name` | `@openclaw/memory-tiered` | NPM package name |
| `type` | `"module"` | ESM module |
| `main` | `index.js` | Entry point (built) |
| `openclaw.extensions` | `["memory"]` | Plugin discovery |

**openclaw.plugin.json** (optional) for additional metadata.

### Dependencies vs DevDependencies

- Runtime deps (sqlite-vec, transformers.js) → `dependencies`
- OpenClaw SDK → `peerDependencies` or `devDependencies` (resolved at runtime via jiti)
- Never use `workspace:*` in dependencies (breaks npm install)

---

## Reference Files to Study

| Purpose | File Path |
|---------|-----------|
| Plugin API types | `src/plugins/types.ts` |
| Plugin registry | `src/plugins/registry.ts` |
| Memory manager | `src/memory/manager.ts` |
| Memory schema | `src/memory/memory-schema.ts` |
| SQLite wrapper | `src/memory/sqlite.ts` |
| sqlite-vec loader | `src/memory/sqlite-vec.ts` |
| Embeddings | `src/memory/embeddings.ts` |
| Memory CLI | `src/cli/memory-cli.ts` |
| Memory-Core plugin | `extensions/memory-core/` |
| Memory-LanceDB plugin | `extensions/memory-lancedb/` |
| Plugin SDK export | `src/plugin-sdk/index.ts` |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| sqlite-vec unavailable | Medium | Medium | In-process cosine fallback |
| Local embedding too large | Low | Medium | Recommend small model |
| Migration data loss | Low | High | --preview, backup, rollback |
| Decay removes wanted memories | Medium | Medium | Audit log, restore, configurable |
| Breaking change from lancedb | Medium | Medium | Deprecation period, migration wizard |

---

## Rollback Strategy

### Feature Flag
- Config: `plugins.slots.memory` controls active plugin
- Rollback: Set to `memory-lancedb`

### Database Rollback
- SQLite DB preserved (not deleted)
- LanceDB remains at original path
- Switch via config change

### Rollback Triggers
- Error rate >1% on memory operations
- Search latency >500ms P95
- Critical bug or data loss

---

## Success Metrics

- Context relevance: qualitative improvement (user feedback)
- 100% of soft-deleted memories restorable
- Works offline with local embedding config
- Search <100ms P95 for 10k memories
- >99% LanceDB migration success rate

---

## Open Questions

1. Which local embedding model for default? (all-MiniLM-L6-v2 vs nomic-embed-text)
2. How to handle embedding dimension changes between providers?
3. Documentation website hosting preference?
