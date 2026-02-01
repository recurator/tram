# Issue: Full memory-tiered needs build step for OpenClaw deployment

**Priority:** Medium  
**Component:** memory-tiered build/packaging  
**Reporter:** Colin  
**Date:** 2026-02-01

---

## Summary

The full implementation cannot be dropped directly into OpenClaw's extensions folder. It requires TypeScript compilation and minor interface adjustments.

---

## Current State

- **Simplified version** working in production (3 tools: store, recall, forget)
- **Full version** at `projects/tiered-memory/implementation/extensions/memory-tiered/` has all features but won't load

---

## Problems

### 1. No compiled output

OpenClaw loads `.js` files, but the full implementation only has `.ts` sources:

```
memory-tiered/
├── index.ts          ← TypeScript (not loadable)
├── tools/*.ts        ← TypeScript
├── core/*.ts         ← TypeScript
├── dist/             ← Empty or outdated
```

**Fix:** Run `npm run build` to compile to `dist/`

### 2. Zod vs TypeBox

Full version uses Zod for config parsing:
```typescript
import { z } from "zod";
const configSchema = z.object({ ... });
```

OpenClaw expects TypeBox:
```typescript
import { Type } from "@sinclair/typebox";
const configSchema = Type.Object({ ... });
```

**Fix:** Replace Zod with TypeBox in `config.ts`, or keep Zod and add TypeBox wrapper for OpenClaw registration.

### 3. Plugin entry point structure

Full version defines custom `PluginApi` interface. OpenClaw provides `OpenClawPluginApi`.

**Fix:** Create adapter `index.ts` that:
- Imports from `openclaw/plugin-sdk`
- Wraps existing tool classes
- Uses OpenClaw's `api.registerTool()` signature

---

## Solution: Build Script

Create `scripts/build-openclaw.sh`:

```bash
#!/bin/bash
set -e

SRC="projects/tiered-memory/implementation/extensions/memory-tiered"
DEST="/usr/lib/node_modules/openclaw/extensions/memory-tiered"

# 1. Compile TypeScript
cd $SRC
npm run build

# 2. Copy compiled output
sudo rm -rf $DEST
sudo mkdir -p $DEST
sudo cp -r dist/* $DEST/
sudo cp package.json $DEST/
sudo cp openclaw.plugin.json $DEST/

# 3. Install production deps
cd $DEST
sudo npm install --production

# 4. Restart gateway
systemctl --user restart openclaw-gateway

echo "Deployed memory-tiered (full) to OpenClaw"
```

---

## Files to Modify

1. **`config.ts`** — Add TypeBox schema alongside Zod, or replace Zod
2. **`index.ts`** — Create OpenClaw adapter (see `/tmp/memory-tiered-full/index-openclaw.ts` for template)
3. **`package.json`** — Add `@sinclair/typebox` to dependencies
4. **`tsconfig.json`** — Ensure `outDir: "dist"` and `module: "ESNext"`

---

## Adapter Template

Already created at: `/tmp/memory-tiered-full/index-openclaw.ts`

Key pattern:
```typescript
import { MemoryStoreTool } from "./tools/memory_store.js";

api.registerTool({
  name: "memory_store",
  parameters: Type.Object({ text: Type.String() }),
  async execute(_toolCallId, params) {
    const result = await storeTool.execute(params);
    return { content: result.content, details: result.details };
  }
}, { name: "memory_store" });
```

---

## Estimated Effort

- **Build script:** 30 min
- **TypeBox migration:** 1-2 hours
- **Adapter index.ts:** 1 hour (template exists)
- **Testing:** 1 hour

**Total:** ~4 hours

---

## Acceptance Criteria

- [ ] `npm run build` produces working `dist/`
- [ ] `npm run deploy:openclaw` installs to OpenClaw extensions
- [ ] All 9 tools registered and functional
- [ ] Decay service runs in background
- [ ] Existing memories preserved after upgrade
