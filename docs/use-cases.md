# TRAM Memory Profiles — Use Cases

This guide shows how to configure TRAM profiles for different agent personas and use cases.

## Profile Overview

TRAM has three profile types:
- **Retrieval** — How memory budgets are allocated across tiers (HOT/WARM/COLD/ARCHIVE)
- **Decay** — How quickly memories transition between tiers
- **Promotion** — Requirements for upgrading memories to higher tiers

---

## 1. Personal Assistant (Default)

**Config:** `retrieval: focused` | `decay: thorough` | `promotion: selective`

**Use case:** Daily companion that remembers recent context well, keeps important facts, and maintains continuity across sessions.

```yaml
# "Remember what we discussed, but don't drown me in ancient history"
retrieval: focused   # 50% HOT, 30% WARM, 15% COLD, 5% ARCHIVE
decay: thorough      # 1d → 7d → 30d
promotion: selective # 3 uses / 2 days to rescue
```

---

## 2. Research Assistant

**Config:** `retrieval: expansive` | `decay: retentive` | `promotion: forgiving`

**Use case:** Long-term research project where insights from 3 months ago matter. Nothing should be forgotten easily.

```yaml
# "Act like an elephant — remember everything"
retrieval: expansive # 0% HOT, 5% WARM, 15% COLD, 80% ARCHIVE
decay: retentive     # 7d → 60d → 180d
promotion: forgiving # 1 use = rescued
```

**Example:** *"What did we conclude about the authentication approach back in October?"*

---

## 3. Support Bot (Stateless)

**Config:** `retrieval: narrow` | `decay: forgetful` | `promotion: ruthless`

**Use case:** FAQ bot handling independent queries. Each conversation is fresh. Privacy-first — forget quickly.

```yaml
# "Goldfish mode — live in the now"
retrieval: narrow    # 70% HOT, 20% WARM, 10% COLD, 0% ARCHIVE
decay: forgetful     # 5m → 15m → 1h
promotion: ruthless  # 10 uses / 5 days to rescue
```

---

## 4. Coding Agent

**Config:** `retrieval: focused` | `decay: attentive` | `promotion: fair`

**Use case:** Pair programming session. Needs recent file context, current task, immediate history. Older project context less critical.

```yaml
# "Sharp focus on current task"
retrieval: focused   # Recent-heavy
decay: attentive     # 1h → 4h → 24h
promotion: fair      # 2 uses / 2 days
```

---

## 5. Wise Mentor (Grandfather)

**Config:** `retrieval: broad` | `decay: thorough` | `promotion: forgiving`

**Use case:** Long-term companion who draws from past conversations to offer perspective. Connects today's question to last month's discussion.

```yaml
# "Let me tell you what I've learned..."
retrieval: broad     # 5% HOT, 25% WARM, 25% COLD, 45% ARCHIVE
decay: thorough      # Holds onto what matters
promotion: forgiving # Second chances for old memories
```

---

## 6. Young Genius (Einstein at 18)

**Config:** `retrieval: narrow` | `decay: attentive` | `promotion: selective`

**Use case:** Focused problem-solver building knowledge rapidly. All about current challenge, minimal historical baggage.

```yaml
# "What's the problem? Let's solve it NOW."
retrieval: narrow    # Recent only
decay: attentive     # Quick learner
promotion: selective # Prove your worth
```

---

## 7. Archivist (Cold Case Investigator)

**Config:** `retrieval: broad` | `decay: casual` | `promotion: demanding`

**Use case:** Digs deep into archives when asked, but doesn't maintain ongoing relationship. Each query is independent research.

```yaml
# "Based on records from 6 months ago..."
retrieval: broad     # Archive access
decay: casual        # Forgets new info quickly
promotion: demanding # Old memories stay buried unless heavily used
```

---

## Runtime Tuning Examples

Use the `memory_tune` tool to adjust profiles at runtime:

```typescript
// User: "Be more retentive"
memory_tune({ decay: "retentive" })
// → Decay timing shifts to 7d/60d/180d

// User: "Focus only on recent stuff"
memory_tune({ retrieval: "narrow" })
// → Injection budget shifts to 70% HOT

// User: "Act like a research assistant"
memory_tune({
  retrieval: "expansive",
  decay: "retentive",
  promotion: "forgiving"
})
// → Full persona shift

// User: "Save this as my default"
memory_tune({
  retrieval: "expansive",
  persist: true,
  scope: "agent"
})
// → Writes to config, survives restart
```

---

## Agent-Scoped Profiles

Configure different profiles per agent in your TRAM config:

```yaml
plugins:
  entries:
    tram:
      # Global defaults
      retrieval:
        profile: focused
      decay:
        profile: thorough
      promotion:
        profile: selective

      # Per-agent overrides
      agents:
        main:
          retrieval: broad
          decay: thorough
        cron:
          retrieval: narrow
          decay: casual
        research-bot:
          retrieval: expansive
          decay: retentive
```

---

## Creating Custom Profiles

Don't see a built-in profile that fits your needs? Create your own custom profiles in the config.

### Custom Retrieval Profile

Define how memory budget is allocated across tiers (must sum to 100):

```yaml
plugins:
  entries:
    tram:
      retrieval:
        profile: my-hybrid-focus  # Use your custom profile
        profiles:
          my-hybrid-focus:        # Define the profile
            hot: 40
            warm: 35
            cold: 20
            archive: 5
```

### Custom Decay Profile

Define how quickly memories transition between tiers using duration strings (`5m`, `2h`, `7d`) or numbers:

```yaml
plugins:
  entries:
    tram:
      decay:
        profile: sprint-mode
        profiles:
          sprint-mode:
            hotTtl: "30m"    # HOT → WARM after 30 minutes
            warmTtl: "2h"    # WARM → COLD after 2 hours
            coldTtl: "12h"   # COLD → ARCHIVE after 12 hours

          marathon-mode:
            hotTtl: "3d"     # HOT → WARM after 3 days
            warmTtl: "30d"   # WARM → COLD after 30 days
            coldTtl: "90d"   # COLD → ARCHIVE after 90 days
```

### Custom Promotion Profile

Define how hard it is for decayed memories to be "rescued" back to higher tiers:

```yaml
plugins:
  entries:
    tram:
      promotion:
        profile: second-chance
        profiles:
          second-chance:
            uses: 2          # Memory must be accessed 2 times
            days: 1          # Within 1 day

          prove-yourself:
            uses: 7          # Memory must be accessed 7 times
            days: 4          # Within 4 days
```

### Complete Custom Configuration Example

Here's a full example combining custom profiles for a "Legal Research Assistant":

```yaml
plugins:
  entries:
    tram:
      retrieval:
        profile: legal-research
        profiles:
          legal-research:
            hot: 15
            warm: 25
            cold: 35
            archive: 25      # High archive access for precedents

      decay:
        profile: legal-retention
        profiles:
          legal-retention:
            hotTtl: "4h"     # Current case context
            warmTtl: "14d"   # Active matter retention
            coldTtl: "365d"  # Long-term precedent storage

      promotion:
        profile: citation-based
        profiles:
          citation-based:
            uses: 2          # Cited twice = important
            days: 30         # Within a month

      # Agent-specific: use custom profiles
      agents:
        main:
          retrieval: legal-research
          decay: legal-retention
          promotion: citation-based
```

### Resolution Order

When looking up a profile by name, TRAM checks:
1. **Custom profiles** (your definitions) — checked first
2. **Built-in profiles** — fallback if custom not found

This means you can also override built-in profiles:

```yaml
# Override the built-in "focused" profile
retrieval:
  profiles:
    focused:              # Same name as built-in
      hot: 60             # Your custom values
      warm: 25
      cold: 10
      archive: 5
```

---

## Profile Reference

### Retrieval Profiles

| Profile | HOT | WARM | COLD | ARCHIVE | Description |
|---------|-----|------|------|---------|-------------|
| narrow | 70% | 20% | 10% | 0% | Focus on most recent |
| focused | 50% | 30% | 15% | 5% | Balance recent over archive (default) |
| balanced | 30% | 30% | 30% | 10% | Equal consideration |
| broad | 5% | 25% | 25% | 45% | Include older memories |
| expansive | 0% | 5% | 15% | 80% | Prioritize historical context |

### Decay Profiles

| Profile | HOT→WARM | WARM→COLD | COLD→ARCHIVE | Description |
|---------|----------|-----------|--------------|-------------|
| forgetful | 5m | 15m | 1h | Forget quickly |
| casual | 15m | 1h | 4h | Light retention |
| attentive | 1h | 4h | 24h | Session-focused |
| thorough | 1d | 7d | 30d | Standard retention (default) |
| retentive | 7d | 60d | 180d | Long-term memory |

### Promotion Profiles

| Profile | Uses | Days | Description |
|---------|------|------|-------------|
| forgiving | 1 | 1 | Easy rescue |
| fair | 2 | 2 | Balanced |
| selective | 3 | 2 | Prove usefulness (default) |
| demanding | 5 | 3 | High bar |
| ruthless | 10 | 5 | Very hard to rescue |
