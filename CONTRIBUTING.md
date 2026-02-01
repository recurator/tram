# Contributing to TRAM

Thank you for your interest in contributing to TRAM! This document provides guidelines and information for contributors.

## Getting Started

1. **Fork the repository** and clone your fork
2. **Install dependencies**: `npm install`
3. **Run tests**: `npm test`
4. **Build**: `npm run build`

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/tram.git
cd tram

# Install dependencies
npm install

# Run tests in watch mode
npm run test:watch

# Type-check without building
npm run typecheck
```

## Project Structure

```
tram/
├── index.ts          # Plugin entry point
├── config.ts         # Configuration schema (Zod)
├── core/             # Core logic
│   ├── decay.ts      # Tier demotion engine
│   ├── promotion.ts  # Tier promotion engine
│   ├── scorer.ts     # Composite scoring
│   └── types.ts      # Type definitions
├── db/               # Database layer
│   ├── sqlite.ts     # SQLite setup
│   ├── fts.ts        # FTS5 helpers
│   └── vectors.ts    # Vector search
├── embeddings/       # Embedding providers
│   ├── local.ts      # Transformers.js
│   └── openai.ts     # OpenAI API
├── tools/            # Agent tools (9)
├── cli/              # CLI commands (12)
├── hooks/            # Auto-recall/capture hooks
└── __tests__/        # Test suite
```

## Code Style

- **TypeScript**: Strict mode enabled
- **Formatting**: Use your editor's TypeScript formatter
- **Naming**: camelCase for variables/functions, PascalCase for types/classes
- **Comments**: JSDoc for public APIs, inline comments for complex logic

## Testing

All changes should include tests:

```bash
# Run all tests
npm test

# Run specific test file
npm test -- scorer.test.ts

# Watch mode
npm run test:watch
```

## Pull Request Process

1. **Create a branch**: `git checkout -b feature/your-feature`
2. **Make changes** and add tests
3. **Run tests**: `npm test`
4. **Type-check**: `npm run typecheck`
5. **Commit** with a clear message
6. **Push** and create a Pull Request

### PR Guidelines

- Keep PRs focused and reasonably sized
- Include tests for new functionality
- Update documentation if needed
- Describe what and why in the PR description

## Commit Messages

Use clear, descriptive commit messages:

```
feat: add support for custom embedding dimensions
fix: handle empty query in memory_recall
docs: update CLI reference in README
test: add scorer edge case tests
```

## Reporting Issues

When reporting issues, please include:

- TRAM version
- OpenClaw version
- Node.js version
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs or error messages

## Feature Requests

Feature requests are welcome! Please:

- Check existing issues first
- Describe the use case
- Explain why it would benefit users

## Code of Conduct

Be respectful, inclusive, and constructive. We're all here to build something useful together.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Questions? Open an issue or reach out to the maintainers.
