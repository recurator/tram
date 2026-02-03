# Issue 013: Investigate Tool Naming Convention (memory_* vs tram_*)

**Plugin:** TRAM  
**Priority:** Medium  
**Type:** Investigation / Possible Bug  
**Date:** 2026-02-02

---

## Summary

TRAM currently registers agent tools with `memory_*` names, but CLI commands use `tram-*` prefix. Need to investigate whether this is intentional (slot-based interface) or a naming violation that should be fixed.

## Current State

**Agent tools (registered by TRAM):**
```
memory_store, memory_recall, memory_forget, memory_restore,
memory_pin, memory_unpin, memory_explain, memory_set_context, memory_clear_context
```

**CLI commands:**
```
tram-search, tram-list, tram-stats, tram-forget, tram-restore,
tram-pin, tram-unpin, tram-explain, tram-set-context, tram-clear-context
```

**Config:**
```json
"plugins": {
  "slots": {
    "memory": "tram"
  }
}
```

## Questions to Investigate

1. **Is `memory_*` a reserved namespace?**
   - Does OpenClaw core define `memory_*` tools that plugins shouldn't override?
   - Or is `memory_*` the generic interface that the memory slot plugin provides?

2. **Slot system design intent:**
   - Is the memory slot meant to provide a standard `memory_*` interface?
   - Or should slot plugins use their own namespace (e.g., `tram_*`)?

3. **Future compatibility:**
   - If OpenClaw adds core `memory_*` tools, will TRAM's tools conflict?
   - Should TRAM proactively switch to `tram_*` to avoid future issues?

## Possible Outcomes

### A: Current naming is correct
- Memory slot plugin provides `memory_*` interface (generic)
- CLI uses `tram-*` for plugin-specific commands
- No change needed

### B: Should use `tram_*` for agent tools
- Rename all agent tools: `memory_store` → `tram_store`, etc.
- Update tool descriptions
- Breaking change for existing users

### C: Hybrid approach
- Keep `memory_*` for standard operations (store, recall, forget)
- Use `tram_*` for TRAM-specific tools (tune, stats, decay)

## Action Items

- [ ] Review OpenClaw plugin documentation for naming conventions
- [ ] Check if other memory plugins (memory-lancedb, memory-tiered) use same pattern
- [ ] Consult with Ralph on intended design
- [ ] If fix needed, create migration plan for tool rename

## Impact on Ticket 012

If tools are renamed to `tram_*`, the proposed `memory_tune` tool should become `tram_tune`.

---

*Investigation triggered during TRAM auto-recall testing session, 2026-02-02*
