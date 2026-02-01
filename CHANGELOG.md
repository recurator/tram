# Changelog

All notable changes to TRAM will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-01-20

### Added

- **4-Tier Memory System**: HOT, WARM, COLD, ARCHIVE tiers with automatic lifecycle management
- **9 Agent Tools**:
  - `memory_store` - Store memories with tier, type, and importance
  - `memory_recall` - Hybrid semantic + full-text search
  - `memory_forget` - Soft-delete with optional hard-delete
  - `memory_restore` - Restore forgotten memories
  - `memory_pin` - Pin memories to bypass decay
  - `memory_unpin` - Resume normal decay
  - `memory_explain` - Explain scoring breakdown
  - `memory_set_context` - Set active task context
  - `memory_clear_context` - Clear context
- **12 CLI Commands**: Full command-line interface for memory management
- **Embedding Providers**:
  - Local embeddings via transformers.js (offline-first)
  - OpenAI embeddings API support
  - Auto mode (local first, fallback to OpenAI)
- **Hybrid Search**: Combines FTS5 full-text search with vector similarity
- **Composite Scoring**: Ranks by similarity × recency × frequency
- **Automatic Decay Service**: Background tier demotion based on access patterns
- **Promotion Engine**: Promotes frequently-accessed memories to higher tiers
- **Deduplication**: Prevents storing semantically duplicate memories
- **Auto-Recall Hook**: Automatically injects relevant memories into agent context
- **Auto-Capture Hook**: Optionally captures important information from conversations
- **SQLite Storage**: Fully local, persistent storage with better-sqlite3
- **LanceDB Migration**: Tool to migrate from LanceDB-based memory systems
- **File Indexer**: Index legacy MEMORY.md and memory/*.md files

### Technical Details

- Built on SQLite with FTS5 and sqlite-vec extensions
- Uses Zod for configuration validation
- Full TypeScript with strict typing
- Vitest test suite included
- Compatible with OpenClaw plugin architecture

---

[0.1.0]: https://github.com/openclaw/tram/releases/tag/v0.1.0
