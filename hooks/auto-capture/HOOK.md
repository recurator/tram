---
name: tram-auto-capture
description: "Automatically capture important information from conversations"
emoji: "📝"
events: ["agent_end"]
---

# TRAM Auto-Capture Hook

Automatically captures important information from agent responses and stores
them in the tiered memory system.

## Behavior

1. Only runs on successful conversations
2. Extracts capturable text segments (10-500 characters)
3. Filters noise (system messages, metadata, XML tags)
4. Detects memory type based on content patterns
5. Checks for duplicates (95% similarity threshold)
6. Stores up to 3 unique memories per conversation in HOT tier

## Configuration

Controlled via plugin config:
- `autoCapture`: Enable/disable (default: true)

## Events

- **agent_end**: Processes conversation when agent completes

## Memory Types

| Type | Detected Patterns |
|------|-------------------|
| **procedural** | "how to", "steps to", "workflow", "install", "configure" |
| **factual** | "is defined as", "means that", "requires", "supports" |
| **project** | "project", "repository", "architecture", "API", "database" |
| **episodic** | "yesterday", "we discussed", "meeting", "conversation" |
