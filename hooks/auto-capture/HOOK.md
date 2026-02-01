---
name: tram-auto-capture
description: "Automatically capture important information from conversations"
emoji: "📝"
events: ["command:stop"]
---

# TRAM Auto-Capture Hook

Automatically captures important information from agent responses and stores
them in the tiered memory system.

## Behavior

1. Extracts capturable text segments from the conversation
2. Detects memory type (procedural, factual, project, episodic)
3. Checks for duplicates using vector similarity
4. Stores unique memories in HOT tier with embeddings

## Configuration

Controlled via plugin config:
- `autoCapture`: Enable/disable (default: true)

## Events

- **command:stop**: Processes conversation when agent stops

## Memory Types

- **procedural**: How-to guides, steps, workflows
- **factual**: Definitions, requirements, syntax
- **project**: Architecture, components, APIs
- **episodic**: Discussions, meetings, agreements
