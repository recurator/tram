---
name: tram-auto-recall
description: "Automatically inject relevant memories into agent context"
metadata:
  openclaw:
    emoji: "🧠"
    events: ["agent:bootstrap"]
---

# TRAM Auto-Recall Hook

Automatically injects relevant memories from the tiered memory system into the
agent's context before processing begins.

## Behavior

1. Extracts key terms from the current prompt/context
2. Performs hybrid search (FTS5 + vector similarity) to find relevant memories
3. Applies tier-based budget allocation (pinned, HOT, WARM, COLD)
4. Formats selected memories as XML and injects into bootstrap files
5. Updates access statistics for retrieved memories

## Configuration

Controlled via plugin config:
- `autoRecall`: Enable/disable (default: true)
- `injection.maxItems`: Maximum memories to inject (default: 20)
- `injection.budgets`: Tier allocation percentages
- `scoring`: Weights for similarity, recency, frequency

## Events

- **agent:bootstrap**: Injects memories into `context.bootstrapFiles`
