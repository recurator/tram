# 🧠 TRAM - Tiered Reversible Associative Memory

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
- **12 CLI Commands** — Complete control from the command line
- **Offline-First** — Local embeddings via transformers.js (no API required)
- **Hybrid Search** — Combines semantic similarity with full-text search (FTS5)
- **Composite Scoring** — Ranks by similarity × recency × frequency
- **Automatic Decay** — Memories naturally age; frequently used ones get promoted
- **Reversible Forget** — Soft-delete with restore capability
- **Deduplication** — Prevents storing duplicate memories
- **Context Injection** — Auto-recalls relevant memories into agent context

## Installation

```bash
npm install @openclaw/tram
```

Or with your package manager of choice:

```bash
pnpm add @openclaw/tram
yarn add @openclaw/tram
```

## Configuration

Add to your OpenClaw config (`openclaw.yaml` or via CLI):

```yaml
extensions:
  tram:
    embedding:
      provider: local  # or 'openai', 'auto'
    autoCapture: true
    autoRecall: true
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `embedding.provider` | `local\|openai\|auto` | `auto` | Embedding provider |
| `embedding.apiKey` | `string` | — | OpenAI API key (if using openai) |
| `embedding.model` | `string` | `text-embedding-3-small` | OpenAI model |
| `dbPath` | `string` | `~/.openclaw/memory/tiered.db` | SQLite database path |
| `autoCapture` | `boolean` | `true` | Auto-capture from conversations |
| `autoRecall` | `boolean` | `true` | Auto-inject relevant memories |

## Tool Reference

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

### Example: Storing a Memory

```typescript
await memory_store({
  text: "User prefers TypeScript over JavaScript",
  tier: "HOT",
  memory_type: "factual",
  importance: 0.8,
  pinned: true
});
```

### Example: Recalling Memories

```typescript
const results = await memory_recall({
  query: "programming language preferences",
  limit: 5
});
```

## CLI Reference

All commands are under `openclaw memory`:

| Command | Description |
|---------|-------------|
| `memory search <query>` | Search memories with hybrid search |
| `memory list` | List memories by tier |
| `memory stats` | Display memory statistics |
| `memory forget <id>` | Forget a memory |
| `memory restore <id>` | Restore a forgotten memory |
| `memory pin <id>` | Pin a memory |
| `memory unpin <id>` | Unpin a memory |
| `memory explain <id>` | Explain memory scoring |
| `memory set-context <text>` | Set current context |
| `memory clear-context` | Clear current context |
| `memory decay run` | Manually trigger decay cycle |
| `memory index` | Index legacy memory files |
| `memory migrate` | Migrate from LanceDB |

### CLI Examples

```bash
# Search for memories about a topic
openclaw memory search "project deadlines" --limit 10

# List all pinned memories
openclaw memory list --pinned

# Show memory statistics
openclaw memory stats --json

# Explain why a memory ranks where it does
openclaw memory explain abc123 --query "meeting notes"
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         TRAM                                 │
├─────────────────────────────────────────────────────────────┤
│  Tools (9)           │  CLI (12)          │  Hooks          │
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

## Requirements

- Node.js 18+
- OpenClaw 0.1.0+
- SQLite3 (included via better-sqlite3)

## License

MIT © OpenClaw Contributors

---

Built with ❤️ for agentic AI systems.
