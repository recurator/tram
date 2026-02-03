# OpenClaw 2026.2.1 Compatibility Notes

This document describes TRAM's compatibility with OpenClaw version 2026.2.1.

## Summary

TRAM v0.2.0 is **fully compatible** with OpenClaw 2026.2.1. No breaking changes were identified, and all existing functionality continues to work as expected.

## Hook System Assessment

### Current Hook Usage

TRAM uses the OpenClaw hook system via `api.on()`:

| Hook Event | TRAM Handler | Purpose |
|------------|--------------|---------|
| `before_agent_start` | `autoRecallHandler` | Inject relevant memories into agent context |
| `agent_end` | `autoCaptureHandler` | Capture important content as new memories |

### before_tool_call Hook (New in 2026.2.1)

OpenClaw 2026.2.1 introduces a new `before_tool_call` hook via PR #6570 and #6660.

**Hook Signature:**
```typescript
interface BeforeToolCallEvent {
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
}

interface BeforeToolCallResult {
  prependContext?: string;  // Content to add before tool execution
  modifyParams?: Record<string, unknown>;  // Modified parameters
}
```

**When It Fires:**
- Before any tool is executed by the agent
- After parameter validation but before execution
- Available context: tool name, parameters, session info

**Available Context:**
- `event.toolName` - Name of the tool being called
- `event.toolCallId` - Unique ID for this tool invocation
- `event.params` - Parameters passed to the tool
- `ctx.session` - Session context (same as other hooks)
- `ctx.workspaceDir` - Current workspace directory

### Assessment

**Current Status:** TRAM does not use `before_tool_call`

**Potential Use Case:** Tool-specific memory injection
- When `memory_recall` is called, inject additional context about past similar searches
- When code-related tools are used, inject procedural memories about coding patterns
- When file operations occur, inject project-specific memories

**Recommendation:** **Defer implementation** to v0.3.0

**Rationale:**
1. Current `before_agent_start` hook provides sufficient context injection for most use cases
2. Tool-specific injection adds complexity with unclear user benefit
3. Memory injection overhead on every tool call could impact performance
4. Better to gather user feedback on current injection quality first

## L2 Normalization Verification

### Current Implementation

TRAM's embedding providers handle normalization as follows:

**Local Embeddings (LocalEmbeddingProvider):**
```typescript
// In embed() method
const output = await pipeline(text, {
  pooling: "mean",
  normalize: true  // L2 normalization enabled
});
```

The `normalize: true` option instructs transformers.js to apply L2 normalization to the output vectors. This ensures unit-length vectors for cosine similarity.

**OpenAI Embeddings (OpenAIEmbeddingProvider):**
- OpenAI's text-embedding-3-* models return L2-normalized vectors by default
- No additional normalization required on TRAM's side

### Cosine Similarity Handling

The `VectorHelper` class computes cosine similarity in `cosineSimilarity()`:

```typescript
private cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) {
    return 0;
  }

  const similarity = dotProduct / (normA * normB);
  return Math.max(0, Math.min(1, similarity));
}
```

**Key Points:**
1. For L2-normalized vectors (norm = 1), `dotProduct / (normA * normB)` equals the dot product
2. The function handles non-normalized vectors correctly by computing norms
3. Output is clamped to [0, 1] to handle floating-point precision errors
4. Zero vectors return 0 similarity (no division by zero)

### OpenClaw 2026.2.1 Changes

OpenClaw 2026.2.1 does not change embedding normalization behavior. The internal memory system continues to expect L2-normalized vectors for optimal cosine similarity performance.

**Verification Status:** TRAM is compatible - embeddings are properly normalized.

## Required TRAM Changes

**No changes required** for OpenClaw 2026.2.1 compatibility.

TRAM v0.2.0 works correctly with OpenClaw 2026.2.1 out of the box.

### API Compatibility

| OpenClaw API | TRAM Usage | Status |
|--------------|------------|--------|
| `api.on()` | Hook registration | Compatible |
| `api.registerTool()` | Tool registration | Compatible |
| `api.registerCli()` | CLI registration | Compatible |
| `api.registerService()` | Background service | Compatible |
| `api.pluginConfig` | Configuration | Compatible |

### Breaking Change Monitoring

The following OpenClaw APIs should be monitored for future breaking changes:

1. **Hook event signatures** - Changes to BeforeAgentStartEvent or AgentEndEvent
2. **Tool registration format** - Changes to ToolDefinition interface
3. **Session context structure** - Changes to session type values
4. **Bootstrap file format** - Changes to context injection mechanism

## Test Commands

### Verify Plugin Registration

```bash
# Check that TRAM loads without errors
openclaw plugins list

# Expected output should include:
# - tram (TRAM) - memory plugin
```

### Verify Hook Registration

```bash
# Enable debug logging
OPENCLAW_LOG_LEVEL=debug openclaw start

# Look for:
# [TRAM] Registered and initialized hooks (auto-recall, auto-capture)
```

### Verify Memory Injection

```bash
# Create a test memory
openclaw run --plugin tram -- tram-search "test"

# Start an agent session and verify memories appear
# The agent's context should include <relevant-memories> XML block
```

### Verify Embedding Normalization

```bash
# Check embedding stats
openclaw run --plugin tram -- tram-stats

# Verify embedding count and provider info
# The embedding provider should be listed (local or openai)
```

### Verify Session Type Detection

```bash
# Test main session (default)
openclaw start
# Session type should be "main"

# Test cron session
openclaw run --session-type cron -- tram-stats
# Session type should be "cron"

# Test spawned session
openclaw spawn --session-type spawned -- tram-stats
# Session type should be "spawned"
```

### Full Integration Test

```bash
# 1. Start OpenClaw with TRAM
openclaw start

# 2. Store a memory
> /memory_store "Test memory for compatibility check"

# 3. Recall memories
> /memory_recall "test"

# 4. Check stats
> /exit
openclaw run --plugin tram -- tram-stats

# 5. Verify decay service is running
openclaw services list
# Should show tram-decay service as running
```

## Version Compatibility Matrix

| TRAM Version | OpenClaw Version | Status |
|--------------|------------------|--------|
| 0.1.x | 2026.1.x | Compatible |
| 0.1.x | 2026.2.0 | Compatible |
| 0.1.x | 2026.2.1 | Compatible |
| 0.2.0 | 2026.1.x | Compatible (new features unavailable) |
| 0.2.0 | 2026.2.0 | Compatible |
| 0.2.0 | 2026.2.1 | **Fully Compatible** |

## Future Considerations

### before_tool_call Integration (v0.3.0 Candidate)

If user feedback indicates need for tool-specific memory injection:

1. Register `before_tool_call` hook alongside existing hooks
2. Implement tool-category mapping (code tools, file tools, search tools)
3. Query memories relevant to tool category
4. Inject as additional prependContext
5. Add configuration option to enable/disable per-tool injection

### Performance Monitoring

Consider adding metrics for:
- Hook execution time (auto-recall, auto-capture)
- Memory injection count per session
- Embedding generation latency
- Hybrid search performance

## Changelog

- **2026-02-03**: Initial compatibility assessment for OpenClaw 2026.2.1
  - Verified hook system compatibility
  - Verified L2 normalization handling
  - Documented before_tool_call hook for future reference
  - Added test commands for verification
