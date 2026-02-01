# Installing memory-tiered as OpenClaw Plugin

**Author:** Colin  
**Date:** 2026-02-01  
**Tested on:** OpenClaw 2026.1.29, Raspberry Pi (arm64), Node 22.22.0

---

## Prerequisites

- OpenClaw installed globally (`/usr/lib/node_modules/openclaw/`)
- sudo access (to write to extensions folder)
- Node.js 22+

---

## Step 1: Create Plugin Directory

```bash
sudo mkdir -p /usr/lib/node_modules/openclaw/extensions/memory-tiered
```

---

## Step 2: Create Plugin Files

### `package.json`

```bash
sudo tee /usr/lib/node_modules/openclaw/extensions/memory-tiered/package.json << 'EOF'
{
  "name": "@openclaw/memory-tiered",
  "version": "0.0.1",
  "description": "Tiered memory with local embeddings for OpenClaw",
  "type": "module",
  "main": "index.ts",
  "dependencies": {
    "@xenova/transformers": "^2.17.2",
    "better-sqlite3": "^12.6.2"
  }
}
EOF
```

### `openclaw.plugin.json`

```bash
sudo tee /usr/lib/node_modules/openclaw/extensions/memory-tiered/openclaw.plugin.json << 'EOF'
{
  "id": "memory-tiered",
  "kind": "memory",
  "configSchema": {
    "type": "object",
    "properties": {
      "embedding": {
        "type": "object",
        "properties": {
          "provider": { "type": "string", "enum": ["local", "openai", "auto"] },
          "apiKey": { "type": "string" },
          "model": { "type": "string" }
        }
      },
      "dbPath": { "type": "string" },
      "autoCapture": { "type": "boolean" },
      "autoRecall": { "type": "boolean" }
    }
  }
}
EOF
```

### `config.ts`

Copy from:
```
projects/tiered-memory/implementation/extensions/memory-tiered/config.ts
```

Or use the simplified version at:
```
/tmp/memory-tiered/config.ts
```

### `index.ts`

This is the main plugin file. Must follow OpenClaw's plugin API:

```typescript
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";

const plugin = {
  id: "memory-tiered",
  name: "Memory (Tiered)",
  kind: "memory" as const,
  configSchema: memoryConfigSchema,

  register(api: OpenClawPluginApi) {
    // Initialize DB, embeddings, tools, hooks, CLI
    // See /usr/lib/node_modules/openclaw/extensions/memory-tiered/index.ts
  }
};

export default plugin;
```

---

## Step 3: Install Dependencies

```bash
cd /usr/lib/node_modules/openclaw/extensions/memory-tiered
sudo npm install
```

This downloads:
- `@xenova/transformers` (~200MB, local embeddings)
- `better-sqlite3` (native SQLite bindings)

Takes ~30-60 seconds on Pi.

---

## Step 4: Configure OpenClaw

Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-tiered"
    },
    "entries": {
      "memory-tiered": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "local"
          },
          "autoCapture": false,
          "autoRecall": true
        }
      }
    }
  }
}
```

Or use CLI:
```bash
openclaw config set plugins.slots.memory memory-tiered
```

---

## Step 5: Restart Gateway

```bash
# If using systemd
systemctl --user restart openclaw-gateway

# Or send SIGUSR1 for graceful reload
kill -USR1 $(pgrep -f openclaw)
```

---

## Step 6: Verify

```bash
openclaw status 2>&1 | grep -i memory
```

Should show:
```
Memory: enabled (plugin memory-tiered)
[plugins] memory-tiered: using local embeddings (all-MiniLM-L6-v2)
[plugins] memory-tiered: plugin registered (db: ~/.openclaw/memory/tiered.db)
```

Test tools:
```bash
# In chat
memory_store("test memory")
memory_recall("test")
```

---

## File Locations Summary

| What | Where |
|------|-------|
| Plugin code | `/usr/lib/node_modules/openclaw/extensions/memory-tiered/` |
| Database | `~/.openclaw/memory/tiered.db` |
| Config | `~/.openclaw/openclaw.json` |
| Logs | `~/.openclaw/logs/gateway.log` |

---

## Troubleshooting

### "Cannot find module 'openclaw/plugin-sdk'"

The plugin runs inside OpenClaw's context — imports resolve from OpenClaw's node_modules. Don't install openclaw as a dependency in the plugin.

### "memory-tiered: unavailable"

First query triggers model download (~30MB). Wait 10-20 seconds, then retry.

### Tool returns OpenAI billing error

Config still pointing to OpenAI. Check:
```json
"embedding": { "provider": "local" }
```

### Database locked

Stop gateway, delete WAL files:
```bash
rm ~/.openclaw/memory/tiered.db-shm ~/.openclaw/memory/tiered.db-wal
```

---

## Rollback to LanceDB

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-lancedb"
    }
  }
}
```

Restart gateway. Old memories still in `~/.openclaw/memory/lancedb/`.
