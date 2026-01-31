/**
 * Legacy file indexing for migrating existing MEMORY.md and memory/*.md files.
 * Chunks files by paragraphs/sections, generates embeddings, and stores as memories.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { Database as SqliteDb } from "better-sqlite3";
import { Tier, MemoryType } from "../core/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { VectorHelper } from "../db/vectors.js";

/**
 * Result from indexing a single file.
 */
export interface FileIndexResult {
  /** Path to the indexed file */
  filePath: string;
  /** Number of chunks created */
  chunksCreated: number;
  /** Whether the file was skipped (already indexed) */
  skipped: boolean;
  /** Error message if indexing failed */
  error?: string;
}

/**
 * Result from a full indexing run.
 */
export interface IndexingResult {
  /** Files found for indexing */
  filesFound: number;
  /** Files successfully indexed */
  filesIndexed: number;
  /** Files skipped (already indexed) */
  filesSkipped: number;
  /** Total chunks created */
  chunksCreated: number;
  /** Detailed results per file */
  files: FileIndexResult[];
}

/**
 * Options for file indexing.
 */
export interface FileIndexerOptions {
  /** Force re-indexing even if file hash matches (default: false) */
  force?: boolean;
  /** Minimum chunk size in characters (default: 50) */
  minChunkSize?: number;
  /** Maximum chunk size in characters (default: 1000) */
  maxChunkSize?: number;
}

/**
 * Similarity threshold for duplicate detection during indexing.
 */
const DUPLICATE_THRESHOLD = 0.95;

/**
 * FileIndexer handles migration of existing memory files into the tiered memory system.
 * Detects MEMORY.md in project root (indexed as WARM) and memory/*.md files (indexed as HOT).
 */
export class FileIndexer {
  private db: SqliteDb;
  private embeddingProvider: EmbeddingProvider;
  private vectorHelper: VectorHelper;
  private projectRoot: string;

  /**
   * Create a new FileIndexer instance.
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
    this.ensureFileHashTable();
  }

  /**
   * Ensure the file_hashes table exists for tracking indexed files.
   */
  private ensureFileHashTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_hashes (
        file_path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  /**
   * Run the indexing process for all legacy memory files.
   * @param options - Indexing options
   * @returns Result of the indexing operation
   */
  async indexAll(options: FileIndexerOptions = {}): Promise<IndexingResult> {
    const result: IndexingResult = {
      filesFound: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      chunksCreated: 0,
      files: [],
    };

    // Find all memory files
    const memoryFiles = this.findMemoryFiles();
    result.filesFound = memoryFiles.length;

    // Index each file
    for (const { filePath, tier } of memoryFiles) {
      const fileResult = await this.indexFile(filePath, tier, options);
      result.files.push(fileResult);

      if (fileResult.skipped) {
        result.filesSkipped++;
      } else if (!fileResult.error) {
        result.filesIndexed++;
        result.chunksCreated += fileResult.chunksCreated;
      }
    }

    return result;
  }

  /**
   * Find all memory files in the project.
   * @returns Array of file paths with their target tiers
   */
  private findMemoryFiles(): Array<{ filePath: string; tier: Tier }> {
    const files: Array<{ filePath: string; tier: Tier }> = [];

    // Check for MEMORY.md in project root
    const rootMemoryPath = join(this.projectRoot, "MEMORY.md");
    if (existsSync(rootMemoryPath) && statSync(rootMemoryPath).isFile()) {
      files.push({ filePath: rootMemoryPath, tier: Tier.WARM });
    }

    // Check for memory/*.md files
    const memoryDir = join(this.projectRoot, "memory");
    if (existsSync(memoryDir) && statSync(memoryDir).isDirectory()) {
      const entries = readdirSync(memoryDir);
      for (const entry of entries) {
        if (entry.endsWith(".md")) {
          const filePath = join(memoryDir, entry);
          if (statSync(filePath).isFile()) {
            files.push({ filePath, tier: Tier.HOT });
          }
        }
      }
    }

    return files;
  }

  /**
   * Index a single file into the memory system.
   * @param filePath - Path to the file
   * @param tier - Target tier for the memories
   * @param options - Indexing options
   * @returns Result of indexing this file
   */
  async indexFile(
    filePath: string,
    tier: Tier,
    options: FileIndexerOptions = {}
  ): Promise<FileIndexResult> {
    const { force = false } = options;

    try {
      // Read file content
      const content = readFileSync(filePath, "utf-8");

      // Compute hash
      const hash = this.computeHash(content);

      // Check if already indexed (unless force is true)
      if (!force && this.isAlreadyIndexed(filePath, hash)) {
        return {
          filePath,
          chunksCreated: 0,
          skipped: true,
        };
      }

      // Chunk the content
      const chunks = this.chunkContent(content, options);

      // Filter out chunks that are too short
      const validChunks = chunks.filter(
        (chunk) => chunk.trim().length >= (options.minChunkSize ?? 50)
      );

      if (validChunks.length === 0) {
        // Save hash even if no chunks (file may be empty or all content too short)
        this.saveFileHash(filePath, hash, 0);
        return {
          filePath,
          chunksCreated: 0,
          skipped: false,
        };
      }

      // Generate embeddings for all chunks in batch
      const embeddings = await this.embeddingProvider.embedBatch(validChunks);

      // Store each chunk as a memory
      let storedCount = 0;
      const source = `file:${this.relativePath(filePath)}`;

      for (let i = 0; i < validChunks.length; i++) {
        const chunkText = validChunks[i];
        const embedding = embeddings[i];

        // Check for duplicates
        const isDuplicate = await this.isDuplicate(embedding);
        if (isDuplicate) {
          continue;
        }

        // Store the chunk as a memory
        await this.storeChunk(chunkText, tier, source, embedding);
        storedCount++;
      }

      // Save file hash
      this.saveFileHash(filePath, hash, storedCount);

      return {
        filePath,
        chunksCreated: storedCount,
        skipped: false,
      };
    } catch (error) {
      return {
        filePath,
        chunksCreated: 0,
        skipped: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Compute SHA-256 hash of content.
   */
  private computeHash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  /**
   * Check if a file has already been indexed with the same hash.
   */
  private isAlreadyIndexed(filePath: string, hash: string): boolean {
    const stmt = this.db.prepare(
      "SELECT hash FROM file_hashes WHERE file_path = ?"
    );
    const result = stmt.get(filePath) as { hash: string } | undefined;
    return result?.hash === hash;
  }

  /**
   * Save file hash to track indexed files.
   */
  private saveFileHash(
    filePath: string,
    hash: string,
    chunkCount: number
  ): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO file_hashes (file_path, hash, indexed_at, chunk_count)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(filePath, hash, new Date().toISOString(), chunkCount);
  }

  /**
   * Get relative path from project root for source field.
   */
  private relativePath(filePath: string): string {
    if (filePath.startsWith(this.projectRoot)) {
      return filePath.slice(this.projectRoot.length + 1);
    }
    return basename(filePath);
  }

  /**
   * Chunk content by paragraphs and sections.
   * Splits on double newlines (paragraphs) and markdown headers.
   * @param content - The file content to chunk
   * @param options - Chunking options
   * @returns Array of text chunks
   */
  private chunkContent(
    content: string,
    options: FileIndexerOptions = {}
  ): string[] {
    const { maxChunkSize = 1000 } = options;
    const chunks: string[] = [];

    // First, split by markdown headers (##, ###, etc.)
    const headerPattern = /(?=^#{1,6}\s)/m;
    const sections = content.split(headerPattern);

    for (const section of sections) {
      // Split each section by double newlines (paragraphs)
      const paragraphs = section.split(/\n\n+/);

      let currentChunk = "";

      for (const paragraph of paragraphs) {
        const trimmed = paragraph.trim();
        if (!trimmed) continue;

        // If adding this paragraph would exceed max size, save current chunk
        if (
          currentChunk &&
          currentChunk.length + trimmed.length + 2 > maxChunkSize
        ) {
          chunks.push(currentChunk.trim());
          currentChunk = "";
        }

        // If paragraph itself is too large, split it further
        if (trimmed.length > maxChunkSize) {
          // First save any current chunk
          if (currentChunk) {
            chunks.push(currentChunk.trim());
            currentChunk = "";
          }
          // Split the large paragraph by sentences or at max size
          const subChunks = this.splitLargeParagraph(trimmed, maxChunkSize);
          chunks.push(...subChunks);
        } else {
          // Add to current chunk
          if (currentChunk) {
            currentChunk += "\n\n" + trimmed;
          } else {
            currentChunk = trimmed;
          }
        }
      }

      // Don't forget the last chunk
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
    }

    return chunks;
  }

  /**
   * Split a large paragraph that exceeds max size.
   * Tries to split on sentence boundaries, falls back to word boundaries.
   */
  private splitLargeParagraph(text: string, maxSize: number): string[] {
    const chunks: string[] = [];

    // Try to split on sentence boundaries
    const sentences = text.split(/(?<=[.!?])\s+/);
    let currentChunk = "";

    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length + 1 > maxSize) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = "";
        }

        // If single sentence is too long, split on words
        if (sentence.length > maxSize) {
          const words = sentence.split(/\s+/);
          let wordChunk = "";
          for (const word of words) {
            if (wordChunk.length + word.length + 1 > maxSize) {
              if (wordChunk) {
                chunks.push(wordChunk.trim());
              }
              wordChunk = word;
            } else {
              wordChunk = wordChunk ? wordChunk + " " + word : word;
            }
          }
          if (wordChunk) {
            currentChunk = wordChunk;
          }
        } else {
          currentChunk = sentence;
        }
      } else {
        currentChunk = currentChunk ? currentChunk + " " + sentence : sentence;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  /**
   * Check if a chunk is a duplicate of an existing memory.
   */
  private async isDuplicate(embedding: number[]): Promise<boolean> {
    const results = this.vectorHelper.vectorSearch(embedding, 1);
    if (results.length === 0) return false;
    return results[0].similarity >= DUPLICATE_THRESHOLD;
  }

  /**
   * Store a chunk as a memory in the database.
   */
  private async storeChunk(
    text: string,
    tier: Tier,
    source: string,
    embedding: number[]
  ): Promise<void> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const today = now.split("T")[0];

    // Insert into memories table
    const insertStmt = this.db.prepare(`
      INSERT INTO memories (
        id, text, importance, category, created_at, tier, memory_type,
        do_not_inject, pinned, use_count, last_accessed_at, use_days, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      id,
      text,
      0.5, // default importance
      null, // no category
      now,
      tier,
      this.detectMemoryType(text),
      0, // do_not_inject
      0, // pinned
      0, // use_count
      now, // last_accessed_at
      JSON.stringify([today]), // use_days
      source
    );

    // Store the embedding
    this.vectorHelper.storeEmbedding(id, embedding);
  }

  /**
   * Detect memory type from text content using pattern matching.
   */
  private detectMemoryType(text: string): MemoryType {
    const lowerText = text.toLowerCase();

    // Procedural: how-to, steps, instructions
    if (
      /how to|step\s*\d|steps to|instructions|procedure|method|process|guide/i.test(
        text
      )
    ) {
      return MemoryType.procedural;
    }

    // Project: file paths, code references, technical specifications
    if (
      /\.(ts|js|py|rs|go|java|md|json|yaml|yml|toml)\b/.test(text) ||
      /src\/|lib\/|test\/|spec\/|config\//.test(text) ||
      /TODO|FIXME|NOTE|BUG|ISSUE|PR|commit/i.test(text)
    ) {
      return MemoryType.project;
    }

    // Episodic: time references, personal events
    if (
      /today|yesterday|last week|just now|recently|earlier|meeting|talked|discussed|decided|agreed/i.test(
        text
      )
    ) {
      return MemoryType.episodic;
    }

    // Default to factual
    return MemoryType.factual;
  }

  /**
   * Get the hash record for a file.
   * @param filePath - Path to the file
   * @returns The hash record or null if not indexed
   */
  getFileHash(
    filePath: string
  ): { hash: string; indexed_at: string; chunk_count: number } | null {
    const stmt = this.db.prepare(
      "SELECT hash, indexed_at, chunk_count FROM file_hashes WHERE file_path = ?"
    );
    const result = stmt.get(filePath) as
      | { hash: string; indexed_at: string; chunk_count: number }
      | undefined;
    return result ?? null;
  }

  /**
   * Clear all file hash records (for force re-indexing).
   */
  clearFileHashes(): void {
    this.db.exec("DELETE FROM file_hashes");
  }

  /**
   * Get all indexed files.
   * @returns Array of indexed file records
   */
  getIndexedFiles(): Array<{
    file_path: string;
    hash: string;
    indexed_at: string;
    chunk_count: number;
  }> {
    const stmt = this.db.prepare("SELECT * FROM file_hashes ORDER BY indexed_at DESC");
    return stmt.all() as Array<{
      file_path: string;
      hash: string;
      indexed_at: string;
      chunk_count: number;
    }>;
  }
}

export default FileIndexer;
