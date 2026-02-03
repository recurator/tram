# Changelog

All notable changes to TRAM will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-02-03

### Added - Injection Quality Filtering

- **minScore Configuration**: Filter low-relevance memories before injection (US-001, US-002)
- **Full Config Schema**: Exposed to OpenClaw with uiHints for settings UI (US-003)
- **Backward Compatibility**: Boolean autoRecall config still supported (US-004)

### Added - Category-Aware Decay

- **Per-Memory-Type TTL Overrides**: Factual memories persist longer than episodic (US-005, US-006)
- **decay.overrides Configuration**: Supports hotTTL/warmTTL per memory type
- **Null TTL Option**: Prevents decay for specific memory types

### Added - Session Isolation

- **Session-Aware Memory Management**: Separate behavior for different session types (US-007, US-008, US-009, US-010)
- **Session Type Configuration**: Distinct settings for main, cron, and spawned sessions
- **Per-Session Settings**: defaultTier, autoCapture, and autoInject per session type
- **Cron Job Isolation**: Cron sessions default to COLD tier to avoid polluting HOT

### Added - Self-Tuning System

- **Database Tables**: injection_feedback and tuning_log tables for tracking (US-011, US-012)
- **Proxy Metric Tracking**: Tracks injection usefulness signals (US-013, US-014)
- **TuningEngine**: Auto-adjustment logic for memory parameters (US-015, US-017, US-018)
- **Parameter Locking**: tram-lock/tram-unlock CLI commands for manual control (US-019)
- **Automatic Tier Sizing**: Self-manages tier sizes within configurable bounds

### Added - Notifications & Reporting

- **TuningReporter**: Multi-channel delivery system (US-016, US-020)
- **Notification Channels**: Supports log, telegram, discord, slack
- **Frequency Modes**: on-change, daily-summary, weekly-summary
- **Metrics Dashboard**: tram stats --metrics command for tuning insights (US-021)

### Added - Benchmarking

- **Benchmark Dataset**: Curated set of 85 memories and 50 queries (US-022)
- **Benchmark Runner**: Compares TRAM vs OpenClaw retrieval (US-023)
- **Retrieval Metrics**: Precision@K, Recall@K, MRR, nDCG

### Added - OpenClaw 2026.2.1 Compatibility

- **Compatibility Documentation**: Full compatibility verified with OpenClaw 2026.2.1 (US-024)
- **before_tool_call Assessment**: Hook integration assessed with working prototype (US-025)
- **Tool-Specific Injection Prototype**: hooks/before-tool-call/handler.ts for tool-aware memory injection
- **v0.3.0 Recommendation**: Full before_tool_call integration deferred to next release

---

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

[0.2.0]: https://github.com/openclaw/tram/releases/tag/v0.2.0
[0.1.0]: https://github.com/openclaw/tram/releases/tag/v0.1.0
