# TRAM - Tiered Reversible Associative Memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue.svg)](https://github.com/openclaw/openclaw)

A memory extension for [OpenClaw](https://github.com/openclaw/openclaw) that gives AI agents persistent, semantic memory with automatic decay and promotion.

## What is TRAM?

**T**iered — 4-tier system (HOT → WARM → COLD → ARCHIVE) for intelligent memory lifecycle
**R**eversible — Soft-delete by default; restore forgotten memories anytime
**A**ssociative — Semantic search using embeddings + full-text search
**M**emory — Persistent SQLite storage, works fully offline

## Features

- **4-Tier System** — HOT (active), WARM (established), COLD (dormant), ARCHIVE (preserved)
- **9 Agent Tools** — Full memory CRUD with pin, explain, and context management
- **13 CLI Commands** — Complete control from the command line
- **Offline-First** — Local embeddings via transformers.js (no API required)
- **Hybrid Search** — Combines semantic similarity with full-text search (FTS5)
- **Composite Scoring** — Ranks by similarity × recency × frequency
- **Automatic Decay** — Memories naturally age; frequently used ones get promoted
- **Reversible Forget** — Soft-delete with restore capability
- **Deduplication** — Prevents storing duplicate memories (95% similarity threshold)
- **Context Injection** — Auto-recalls relevant memories into agent context

## Installation

```bash
openclaw plugins install @openclaw/tram
openclaw plugins enable tram
```

Done. TRAM auto-captures and auto-recalls by default.

Verify with:
```bash
openclaw tram-stats
```

### Development Install

For local development:

```bash
openclaw plugins install -l ./path/to/tram
openclaw plugins enable tram
```

## Configuration

Add to your OpenClaw config (`openclaw.yaml` or `openclaw.config.json`):

```yaml
extensions:
  tram:
    embedding:
      provider: local  # 'local', 'openai', or 'auto'
    autoCapture: true
    autoRecall: true
```

### Configuration Options

#### Embedding Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `embedding.provider` | string | `auto` | `local`, `openai`, or `auto` (tries local first) |
| `embedding.apiKey` | `string` | — | OpenAI API key (or set `OPENAI_API_KEY` env var) |
| `embedding.model` | `string` | `text-embedding-3-small` | OpenAI model |
| `embedding.local.modelPath` | `string` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model ID |

#### Core Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dbPath` | `string` | `~/.openclaw/memory/tiered.db` | SQLite database path |
| `autoCapture` | `boolean` | `true` | Auto-capture from conversations |
| `autoRecall` | `boolean` | `true` | Auto-inject relevant memories |

#### Tier Thresholds

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `tiers.hot.ttlHours` | `number` | `72` | Hours before HOT demotes to COLD |
| `tiers.warm.demotionDays` | `number` | `60` | Days of inactivity before WARM demotes |
| `tiers.cold.promotionUses` | `number` | `3` | Uses required for COLD → WARM promotion |
| `tiers.cold.promotionDays` | `number` | `2` | Distinct days required for promotion |

#### Scoring Weights

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `scoring.similarity` | `number` | `0.5` | Semantic similarity weight (0.0-1.0) |
| `scoring.recency` | `number` | `0.3` | Recency weight (0.0-1.0) |
| `scoring.frequency` | `number` | `0.2` | Access frequency weight (0.0-1.0) |

#### Injection Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `injection.maxItems` | `number` | `20` | Maximum memories to inject |
| `injection.budgets.pinned` | `number` | `25` | % of slots for pinned memories |
| `injection.budgets.hot` | `number` | `45` | % of slots for HOT tier |
| `injection.budgets.warm` | `number` | `25` | % of slots for WARM tier |
| `injection.budgets.cold` | `number` | `5` | % of slots for COLD tier |

#### Other Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `decay.intervalHours` | `number` | `6` | Hours between automatic decay runs |
| `context.ttlHours` | `number` | `4` | Default TTL for task context |

### Full Configuration Example

```yaml
extensions:
  tram:
    embedding:
      provider: local
      local:
        modelPath: Xenova/all-MiniLM-L6-v2
    dbPath: ~/.openclaw/memory/tiered.db
    autoCapture: true
    autoRecall: true
    tiers:
      hot:
        ttlHours: 72
      warm:
        demotionDays: 60
      cold:
        promotionUses: 3
        promotionDays: 2
    scoring:
      similarity: 0.5
      recency: 0.3
      frequency: 0.2
    injection:
      maxItems: 20
      budgets:
        pinned: 25
        hot: 45
        warm: 25
        cold: 5
    decay:
      intervalHours: 6
    context:
      ttlHours: 4
```

## Tool Reference

### Tools Overview

| Tool | Description |
|------|-------------|
| `memory_store` | Store a new memory with tier, importance, and type |
| `memory_recall` | Search memories using hybrid semantic + text search |
| `memory_forget` | Soft-delete a memory (reversible) or hard-delete |
| `memory_restore` | Restore a previously forgotten memory |
| `memory_pin` | Pin a memory to bypass decay |
| `memory_unpin` | Unpin a memory to resume normal decay |
| `memory_explain` | Explain how a memory is scored |
| `memory_set_context` | Set active task context for recall |
| `memory_clear_context` | Clear the current context |

### Tool Parameters

#### memory_store

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | string | Yes | — | The memory content |
| `tier` | string | No | `HOT` | Initial tier: `HOT` or `WARM` |
| `memory_type` | string | No | `factual` | Type: `procedural`, `factual`, `project`, `episodic` |
| `importance` | number | No | `0.5` | Importance score (0.0-1.0) |
| `pinned` | boolean | No | `false` | Pin this memory |
| `category` | string | No | — | Category for grouping |
| `source` | string | No | — | Origin of the memory |

#### memory_recall

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | — | Search query text |
| `limit` | number | No | `5` | Maximum results |
| `tier` | string | No | — | Filter by tier |
| `includeArchive` | boolean | No | `false` | Include ARCHIVE tier |
| `includeForgotten` | boolean | No | `false` | Include forgotten memories |

#### memory_forget

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `memoryId` | string | No* | — | Memory ID (UUID) |
| `query` | string | No* | — | Search query to find memory |
| `hard` | boolean | No | `false` | Permanently delete |

*One of `memoryId` or `query` is required.

#### memory_restore / memory_pin / memory_unpin / memory_explain

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `memoryId` | string | Yes | Memory ID (UUID) |

#### memory_set_context

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | string | Yes | — | Context text |
| `ttlHours` | number | No | `4` | Time-to-live in hours |

### Tool Examples

```typescript
// Store a memory
await memory_store({
  text: "User prefers TypeScript over JavaScript",
  tier: "HOT",
  memory_type: "factual",
  importance: 0.8,
  pinned: true
});

// Recall memories
const results = await memory_recall({
  query: "programming language preferences",
  limit: 5,
  tier: "HOT"
});

// Forget a memory (soft delete)
await memory_forget({
  memoryId: "550e8400-e29b-41d4-a716-446655440000"
});

// Set task context
await memory_set_context({
  text: "Working on authentication module",
  ttlHours: 8
});
```

## CLI Reference

All commands use the `tram-` prefix:

| Command | Description |
|---------|-------------|
| `tram-search <query>` | Search memories with hybrid search |
| `tram-list` | List memories by tier |
| `tram-stats` | Display memory statistics |
| `tram-forget <id>` | Forget a memory |
| `tram-restore <id>` | Restore a forgotten memory |
| `tram-pin <id>` | Pin a memory |
| `tram-unpin <id>` | Unpin a memory |
| `tram-explain <id>` | Explain memory scoring |
| `tram-set-context <text>` | Set current context |
| `tram-clear-context` | Clear current context |
| `tram-decay run` | Manually trigger decay cycle |
| `tram-index` | Index legacy memory files |
| `tram-migrate` | Migrate from LanceDB |

### CLI Options

#### tram-search

```bash
openclaw tram-search <query> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--deep` | Include ARCHIVE tier | `false` |
| `--tier <tier>` | Filter by tier | — |
| `--limit <n>` | Max results | `10` |
| `--json` | Output as JSON | `false` |
| `--explain` | Show scoring breakdown | `false` |

#### tram-list

```bash
openclaw tram-list [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--tier <tier>` | Filter by tier | — |
| `--forgotten` | Show only forgotten | `false` |
| `--pinned` | Show only pinned | `false` |
| `--sort <field>` | Sort by field | `created_at` |
| `--limit <n>` | Max results | `20` |
| `--json` | Output as JSON | `false` |

#### tram-forget

```bash
openclaw tram-forget <id> [options]
```

| Option | Description |
|--------|-------------|
| `--hard` | Permanently delete |
| `--confirm` | Required with `--hard` |
| `--json` | Output as JSON |

### CLI Examples

```bash
# Search for memories about a topic
openclaw tram-search "project deadlines" --limit 10

# Search with scoring explanation
openclaw tram-search "authentication" --explain

# List all pinned memories
openclaw tram-list --pinned

# List HOT tier as JSON
openclaw tram-list --tier HOT --json

# Show memory statistics
openclaw tram-stats

# Explain why a memory ranks where it does
openclaw tram-explain abc123 --query "meeting notes"

# Permanently delete a memory
openclaw tram-forget abc123 --hard --confirm

# Migrate from LanceDB (preview first)
openclaw tram-migrate --from lancedb --preview
openclaw tram-migrate --from lancedb
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         TRAM                                 │
├─────────────────────────────────────────────────────────────┤
│  Tools (9)           │  CLI (13)          │  Hooks          │
│  ├── memory_store    │  ├── search        │  ├── auto_recall│
│  ├── memory_recall   │  ├── list          │  └── auto_capture│
│  ├── memory_forget   │  ├── stats         │                  │
│  ├── memory_restore  │  ├── forget        │  Services       │
│  ├── memory_pin      │  ├── restore       │  └── decay_service│
│  ├── memory_unpin    │  ├── pin/unpin     │                  │
│  ├── memory_explain  │  ├── explain       │                  │
│  ├── memory_set_ctx  │  ├── set-context   │                  │
│  └── memory_clear_ctx│  ├── clear-context │                  │
│                      │  ├── decay run     │                  │
│                      │  ├── index         │                  │
│                      │  └── migrate       │                  │
├─────────────────────────────────────────────────────────────┤
│                        Core                                  │
│  ├── scorer.ts (composite scoring)                          │
│  ├── decay.ts (tier demotion)                               │
│  ├── promotion.ts (tier promotion)                          │
│  └── injection.ts (context assembly)                        │
├─────────────────────────────────────────────────────────────┤
│                      Database                                │
│  ├── sqlite.ts (better-sqlite3)                             │
│  ├── fts.ts (FTS5 full-text search)                         │
│  └── vectors.ts (sqlite-vec embeddings)                     │
├─────────────────────────────────────────────────────────────┤
│                     Embeddings                               │
│  ├── local.ts (transformers.js - offline)                   │
│  └── openai.ts (OpenAI API)                                 │
└─────────────────────────────────────────────────────────────┘
```

### Tier Lifecycle

```
     ┌────────┐
     │  NEW   │
     └───┬────┘
         │ store
         ▼
     ┌────────┐    72h no access     ┌────────┐
     │  HOT   │ ─────────────────────▶│  COLD  │
     └────────┘                       └───┬────┘
         ▲                                │
         │ 3+ uses on 2+ days             │ 60+ days inactive
         │                                ▼
     ┌────────┐                      ┌─────────┐
     │  WARM  │◀─────────────────────│ ARCHIVE │
     └────────┘   manual restore     └─────────┘
```

### Composite Scoring

Memories are ranked using a composite score:

```
score = (similarity × w_sim) + (recency × w_rec) + (frequency × w_freq)
```

Default weights: similarity=0.5, recency=0.3, frequency=0.2

**Recency decay by memory type:**

| Type | Half-life | Use case |
|------|-----------|----------|
| `procedural` | 180 days | How-to guides, workflows |
| `factual` | 90 days | Definitions, syntax |
| `project` | 45 days | Architecture, APIs |
| `episodic` | 10 days | Meetings, discussions |

## Hooks

TRAM provides two hooks that integrate with OpenClaw's event system:

### auto_recall (before_agent_start)

Automatically injects relevant memories into agent context.

- Extracts key terms from user prompt
- Performs hybrid search (FTS5 + vector)
- Applies tier budget allocation
- Injects as XML format

### auto_capture (agent_end)

Automatically captures important information from conversations.

- Only runs on successful conversations
- Detects memory type from content patterns
- Checks for duplicates (95% threshold)
- Stores up to 3 memories per conversation

## Requirements

- Node.js 20+ (tested on Node 22)
- OpenClaw 2026.0.0+
- SQLite3 (included via better-sqlite3)

## Troubleshooting

### Common Issues

**"Cannot find module" errors**
```bash
npm rebuild better-sqlite3
```

**Slow first search**
Local embeddings download on first use (~30MB). Subsequent searches are fast.

**Memory not being recalled**
Check that `autoRecall: true` is set and the memory isn't forgotten:
```bash
openclaw tram-list --forgotten
```

## License

MIT

---

Built for agentic AI systems.
