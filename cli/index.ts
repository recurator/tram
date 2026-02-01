/**
 * CLI index command - Trigger file indexing for legacy memory files.
 * Command: openclaw memory index
 * Options: --force to re-index all files (ignore hash)
 * Shows progress (files found, chunks created, skipped)
 */

import type { Database as SqliteDb } from "better-sqlite3";
import { FileIndexer, type IndexingResult, type FileIndexResult } from "../migration/file_indexer.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { VectorHelper } from "../db/vectors.js";

/**
 * CLI index command options
 */
export interface IndexOptions {
  /** Force re-indexing even if file hash matches */
  force?: boolean;
  /** Output as JSON */
  json?: boolean;
}

/**
 * Index command result for CLI output
 */
export interface IndexCommandResult {
  /** Files found for indexing */
  filesFound: number;
  /** Files successfully indexed */
  filesIndexed: number;
  /** Files skipped (already indexed) */
  filesSkipped: number;
  /** Total chunks created */
  chunksCreated: number;
  /** Whether force mode was used */
  forceMode: boolean;
  /** Detailed results per file */
  files: FileIndexResult[];
  /** Success message */
  message: string;
}

/**
 * Format a file result line for text output
 */
function formatFileResult(result: FileIndexResult): string {
  if (result.skipped) {
    return `  [SKIPPED] ${result.filePath}`;
  }
  if (result.error) {
    return `  [ERROR]   ${result.filePath}: ${result.error}`;
  }
  return `  [INDEXED] ${result.filePath} (${result.chunksCreated} chunks)`;
}

/**
 * Format index result for CLI text output
 */
function formatTextOutput(result: IndexCommandResult): string {
  const lines: string[] = [];

  // Header
  lines.push("Memory File Indexing");
  lines.push("====================");
  lines.push("");

  // Mode indicator
  if (result.forceMode) {
    lines.push("Mode: Force re-index (ignoring file hashes)");
    lines.push("");
  }

  // Summary
  lines.push("Summary:");
  lines.push(`  Files found:   ${result.filesFound}`);
  lines.push(`  Files indexed: ${result.filesIndexed}`);
  lines.push(`  Files skipped: ${result.filesSkipped}`);
  lines.push(`  Chunks created: ${result.chunksCreated}`);
  lines.push("");

  // File details
  if (result.files.length > 0) {
    lines.push("Files:");
    for (const file of result.files) {
      lines.push(formatFileResult(file));
    }
    lines.push("");
  } else {
    lines.push("No memory files found (MEMORY.md or memory/*.md)");
    lines.push("");
  }

  // Final message
  lines.push(result.message);

  return lines.join("\n");
}

/**
 * MemoryIndexCommand implements the CLI file indexing functionality.
 * Triggers indexing of MEMORY.md and memory/*.md files.
 */
export class MemoryIndexCommand {
  private db: SqliteDb;
  private embeddingProvider: EmbeddingProvider;
  private vectorHelper: VectorHelper;
  private projectRoot: string;

  /**
   * Create a new MemoryIndexCommand instance.
   * @param db - The better-sqlite3 database instance
   * @param embeddingProvider - Provider for generating embeddings
   * @param vectorHelper - Helper for vector storage and search
   * @param projectRoot - Root directory of the project (default: process.cwd())
   */
  constructor(
    db: SqliteDb,
    embeddingProvider: EmbeddingProvider,
    vectorHelper: VectorHelper,
    projectRoot: string = process.cwd()
  ) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    this.vectorHelper = vectorHelper;
    this.projectRoot = projectRoot;
  }

  /**
   * Execute the index command.
   * @param options - Command options
   * @returns Formatted output string
   */
  async execute(options: IndexOptions = {}): Promise<string> {
    const { force = false, json = false } = options;

    // Create file indexer
    const indexer = new FileIndexer(
      this.db,
      this.embeddingProvider,
      this.vectorHelper,
      this.projectRoot
    );

    // If force mode, clear file hashes first
    if (force) {
      indexer.clearFileHashes();
    }

    // Run indexing
    const indexResult: IndexingResult = await indexer.indexAll({ force });

    // Build command result
    const result: IndexCommandResult = {
      filesFound: indexResult.filesFound,
      filesIndexed: indexResult.filesIndexed,
      filesSkipped: indexResult.filesSkipped,
      chunksCreated: indexResult.chunksCreated,
      forceMode: force,
      files: indexResult.files,
      message: this.buildMessage(indexResult, force),
    };

    if (json) {
      return JSON.stringify(result, null, 2);
    }

    return formatTextOutput(result);
  }

  /**
   * Build the success message based on results.
   */
  private buildMessage(result: IndexingResult, force: boolean): string {
    if (result.filesFound === 0) {
      return "No memory files found to index. Create MEMORY.md or files in memory/ directory.";
    }

    if (result.filesIndexed === 0 && result.filesSkipped > 0) {
      return force
        ? "All files already indexed. Use --force to re-index."
        : "All files already indexed (unchanged since last index).";
    }

    const parts: string[] = [];
    if (result.filesIndexed > 0) {
      parts.push(`Indexed ${result.filesIndexed} file(s) with ${result.chunksCreated} chunk(s)`);
    }
    if (result.filesSkipped > 0) {
      parts.push(`Skipped ${result.filesSkipped} unchanged file(s)`);
    }

    return parts.join(". ") + ".";
  }
}

export default MemoryIndexCommand;
