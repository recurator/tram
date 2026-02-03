---
name: tram-auto-recall
description: "Automatically inject relevant memories into agent context"
emoji: "🧠"
events: ["before_agent_start"]
---

# TRAM Auto-Recall Hook

Automatically injects relevant memories from the tiered memory system into the
agent's context before processing begins.

## Behavior

1. Extracts key terms from the current prompt/context
2. Performs hybrid search (FTS5 + vector similarity) to find relevant memories
3. Applies tier-based budget allocation (pinned, HOT, WARM, COLD)
4. Formats selected memories as XML and prepends to context
5. Updates access statistics for retrieved memories

## Injected Format

```xml
<relevant-memories>
  <current-context>Task context if set</current-context>
  <memory id="uuid" tier="HOT" type="factual">Memory text</memory>
</relevant-memories>
```

## Configuration

Controlled via plugin config:
- `autoRecall`: Enable/disable (default: true)
- `injection.maxItems`: Maximum memories to inject (default: 20)
- `injection.budgets`: Tier allocation percentages
- `scoring`: Weights for similarity, recency, frequency

## Events

- **before_agent_start**: Injects memories into agent context
