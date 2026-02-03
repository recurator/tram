# TRAM Installation

## Install

```bash
openclaw plugins install @openclaw/tram
openclaw plugins enable tram
```

## Verify

```bash
openclaw tram-stats
```

## Configure (Optional)

View current config:
```bash
openclaw plugins info tram
```

Override defaults in `~/.openclaw/openclaw.yaml`:

```yaml
extensions:
  tram:
    embedding:
      provider: local    # 'local', 'openai', or 'auto'
    autoCapture: true
    autoRecall: true
```

See README.md for full configuration reference.

## Development Install

For local development, use `--link` to avoid copying:

```bash
openclaw plugins install -l ./path/to/tram
openclaw plugins enable tram
```

## Plugin Management

```bash
openclaw plugins list          # List all plugins
openclaw plugins info tram     # View plugin details
openclaw plugins disable tram  # Disable plugin
openclaw plugins update tram   # Update plugin
openclaw plugins doctor        # Diagnose issues
```

## Troubleshooting

**Slow first search** — Local embeddings download on first use (~30MB).

**Database locked** — `rm ~/.openclaw/memory/tiered.db-shm ~/.openclaw/memory/tiered.db-wal`

**Plugin issues** — `openclaw plugins doctor`
