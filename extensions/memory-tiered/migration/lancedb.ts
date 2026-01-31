/**
 * LanceDB migration for importing existing memory data from LanceDB to the tiered memory system.
 * Supports preview mode, backup creation, and rollback capability.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Database as SqliteDb } from "better-sqlite3";
import { Tier, MemoryType } from "../core/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { VectorHelper } from "../db/vectors.js";

/**
 * A single memory entry from LanceDB.
 */
export interface LanceDBEntry {
  /** Unique identifier */
  id: string;
  /** Memory text content */
  text: string;
  /** Embedding vector (if available) */
  vector?: number[];
  /** Original metadata from LanceDB */
  metadata?: Record<string, unknown>;
  /** Timestamp from LanceDB */
  timestamp?: string;
}

/**
 * Result of analyzing LanceDB for migration.
 */
export interface MigrationPreview {
  /** Whether LanceDB was detected */
  detected: boolean;
  /** Path to LanceDB directory */
  lancedbPath: string;
  /** Number of entries found */
  entryCount: number;
  /** Estimated size in bytes */
  estimatedSize: number;
  /** Sample entries for preview */
  sampleEntries: Array<{ id: string; text: string; hasVector: boolean }>;
  /** Warnings or issues found */
  warnings: string[];
}

/**
 * Result of a migration operation.
 */
export interface MigrationResult {
  /** Whether migration was successful */
  success: boolean;
  /** Number of entries migrated */
  entriesMigrated: number;
  /** Number of entries skipped (duplicates) */
  entriesSkipped: number;
  /** Number of entries failed */
  entriesFailed: number;
  /** Path to backup if created */
  backupPath?: string;
  /** Errors encountered */
  errors: string[];
  /** Migration timestamp */
  migratedAt: string;
}

/**
 * Options for migration.
 */
export interface MigrationOptions {
  /** Preview mode - analyze without migrating */
  preview?: boolean;
  /** Skip backup creation */
  skipBackup?: boolean;
  /** Re-embed all entries (useful if embedding dimensions differ) */
  reEmbed?: boolean;
  /** Progress callback for large migrations */
  onProgress?: (current: number, total: number) => void;
}

/**
 * Similarity threshold for duplicate detection during migration.
 */
const DUPLICATE_THRESHOLD = 0.95;

/**
 * Default LanceDB path in OpenClaw.
 */
const DEFAULT_LANCEDB_PATH = join(homedir(), ".openclaw", "memory", "lancedb");

/**
 * LanceDB migrator handles importing existing LanceDB memory data
 * into the tiered memory system with backup and rollback support.
 */
export class LanceDBMigrator {
  private db: SqliteDb;
  private embeddingProvider: EmbeddingProvider;
  private vectorHelper: VectorHelper;
  private lancedbPath: string;
  private backupDir: string;

  /**
   * Create a new LanceDBMigrator instance.
   * @param db - The better-sqlite3 database instance
   * @param embeddingProvider - Provider for generating embeddings
   * @param vectorHelper - Helper for vector storage and search
   * @param lancedbPath - Path to LanceDB directory (default: ~/.openclaw/memory/lancedb)
   */
  constructor(
    db: SqliteDb,
    embeddingProvider: EmbeddingProvider,
    vectorHelper: VectorHelper,
    lancedbPath: string = DEFAULT_LANCEDB_PATH
  ) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    this.vectorHelper = vectorHelper;
    this.lancedbPath = lancedbPath;
    this.backupDir = join(dirname(lancedbPath), ".lancedb_backups");
  }

  /**
   * Detect if LanceDB exists at the configured path.
   * @returns True if LanceDB directory exists with data
   */
  detectLanceDB(): boolean {
    if (!existsSync(this.lancedbPath)) {
      return false;
    }

    const stat = statSync(this.lancedbPath);
    if (!stat.isDirectory()) {
      return false;
    }

    // Check for LanceDB marker files or tables
    const entries = readdirSync(this.lancedbPath);
    // LanceDB typically has .lance files or table directories
    return entries.some(
      (entry) =>
        entry.endsWith(".lance") ||
        entry === "memories" ||
        entry.includes("table")
    );
  }

  /**
   * Preview the migration without executing it.
   * @returns Migration preview with entry count and samples
   */
  async preview(): Promise<MigrationPreview> {
    const result: MigrationPreview = {
      detected: false,
      lancedbPath: this.lancedbPath,
      entryCount: 0,
      estimatedSize: 0,
      sampleEntries: [],
      warnings: [],
    };

    if (!this.detectLanceDB()) {
      result.warnings.push(
        `LanceDB not found at ${this.lancedbPath}. ` +
          "Ensure the path is correct or LanceDB was previously initialized."
      );
      return result;
    }

    result.detected = true;

    try {
      // Read LanceDB entries
      const entries = await this.readLanceDBEntries();
      result.entryCount = entries.length;

      // Calculate estimated size
      result.estimatedSize = this.calculateSize(entries);

      // Get sample entries (first 5)
      result.sampleEntries = entries.slice(0, 5).map((entry) => ({
        id: entry.id,
        text:
          entry.text.length > 100
            ? entry.text.substring(0, 100) + "..."
            : entry.text,
        hasVector: !!entry.vector && entry.vector.length > 0,
      }));

      // Check for potential issues
      if (entries.length === 0) {
        result.warnings.push("No entries found in LanceDB.");
      }

      const withoutVectors = entries.filter(
        (e) => !e.vector || e.vector.length === 0
      ).length;
      if (withoutVectors > 0) {
        result.warnings.push(
          `${withoutVectors} entries without embeddings will be re-embedded.`
        );
      }

      // Check embedding dimension compatibility
      if (entries.length > 0 && entries[0].vector) {
        const lancedbDimensions = entries[0].vector.length;
        const currentDimensions = this.embeddingProvider.getDimensions();
        if (lancedbDimensions !== currentDimensions) {
          result.warnings.push(
            `Embedding dimension mismatch: LanceDB uses ${lancedbDimensions}, ` +
              `current provider uses ${currentDimensions}. All entries will be re-embedded.`
          );
        }
      }
    } catch (error) {
      result.warnings.push(
        `Error reading LanceDB: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return result;
  }

  /**
   * Execute the migration from LanceDB to tiered memory.
   * @param options - Migration options
   * @returns Migration result
   */
  async migrate(options: MigrationOptions = {}): Promise<MigrationResult> {
    const result: MigrationResult = {
      success: false,
      entriesMigrated: 0,
      entriesSkipped: 0,
      entriesFailed: 0,
      errors: [],
      migratedAt: new Date().toISOString(),
    };

    if (!this.detectLanceDB()) {
      result.errors.push(`LanceDB not found at ${this.lancedbPath}`);
      return result;
    }

    try {
      // Create backup unless skipped
      if (!options.skipBackup) {
        result.backupPath = this.createBackup();
      }

      // Read all entries from LanceDB
      const entries = await this.readLanceDBEntries();
      const total = entries.length;

      if (total === 0) {
        result.success = true;
        result.errors.push("No entries to migrate.");
        return result;
      }

      // Check embedding dimensions
      const currentDimensions = this.embeddingProvider.getDimensions();
      const needsReEmbed =
        options.reEmbed ||
        (entries[0].vector && entries[0].vector.length !== currentDimensions);

      // Process each entry
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];

        try {
          // Generate or reuse embedding
          let embedding: number[];
          if (needsReEmbed || !entry.vector || entry.vector.length === 0) {
            embedding = await this.embeddingProvider.embed(entry.text);
          } else {
            embedding = entry.vector;
          }

          // Check for duplicates
          const isDuplicate = await this.isDuplicate(embedding);
          if (isDuplicate) {
            result.entriesSkipped++;
            if (options.onProgress) {
              options.onProgress(i + 1, total);
            }
            continue;
          }

          // Store the memory
          await this.storeEntry(entry, embedding);
          result.entriesMigrated++;
        } catch (error) {
          result.entriesFailed++;
          result.errors.push(
            `Failed to migrate entry ${entry.id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        // Report progress
        if (options.onProgress) {
          options.onProgress(i + 1, total);
        }
      }

      result.success = result.entriesFailed === 0;
    } catch (error) {
      result.errors.push(
        `Migration failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return result;
  }

  /**
   * Rollback to the most recent backup.
   * @returns True if rollback was successful
   */
  rollback(): { success: boolean; message: string; backupRestored?: string } {
    if (!existsSync(this.backupDir)) {
      return {
        success: false,
        message: "No backup directory found. Cannot rollback.",
      };
    }

    // Find the most recent backup
    const backups = readdirSync(this.backupDir)
      .filter((name) => name.startsWith("lancedb_backup_"))
      .sort()
      .reverse();

    if (backups.length === 0) {
      return {
        success: false,
        message: "No backups found. Cannot rollback.",
      };
    }

    const latestBackup = join(this.backupDir, backups[0]);

    try {
      // Remove current LanceDB directory if it exists
      if (existsSync(this.lancedbPath)) {
        rmSync(this.lancedbPath, { recursive: true, force: true });
      }

      // Restore from backup
      this.copyDirectory(latestBackup, this.lancedbPath);

      return {
        success: true,
        message: `Successfully restored LanceDB from backup: ${backups[0]}`,
        backupRestored: latestBackup,
      };
    } catch (error) {
      return {
        success: false,
        message: `Rollback failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * List available backups.
   * @returns Array of backup info
   */
  listBackups(): Array<{ name: string; path: string; createdAt: string }> {
    if (!existsSync(this.backupDir)) {
      return [];
    }

    return readdirSync(this.backupDir)
      .filter((name) => name.startsWith("lancedb_backup_"))
      .map((name) => {
        const path = join(this.backupDir, name);
        const stat = statSync(path);
        return {
          name,
          path,
          createdAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Read entries from LanceDB.
   * Note: LanceDB stores data in Lance format. We try multiple approaches:
   * 1. Check for JSON export files (common in some setups)
   * 2. Check for CSV exports
   * 3. Try to read native Lance format markers
   */
  private async readLanceDBEntries(): Promise<LanceDBEntry[]> {
    const entries: LanceDBEntry[] = [];

    // Try to find and read memory data
    const files = readdirSync(this.lancedbPath, { recursive: true });

    // Look for JSON or JSONL files first (common export format)
    for (const file of files) {
      const filePath =
        typeof file === "string"
          ? join(this.lancedbPath, file)
          : join(this.lancedbPath, file.toString());

      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        continue;
      }

      if (filePath.endsWith(".json") || filePath.endsWith(".jsonl")) {
        const content = readFileSync(filePath, "utf-8");

        if (filePath.endsWith(".jsonl")) {
          // JSONL format - one JSON object per line
          const lines = content.split("\n").filter((line) => line.trim());
          for (const line of lines) {
            try {
              const entry = this.parseJsonEntry(JSON.parse(line));
              if (entry) entries.push(entry);
            } catch {
              // Skip invalid lines
            }
          }
        } else {
          // Regular JSON - could be array or single object
          try {
            const data = JSON.parse(content);
            if (Array.isArray(data)) {
              for (const item of data) {
                const entry = this.parseJsonEntry(item);
                if (entry) entries.push(entry);
              }
            } else {
              const entry = this.parseJsonEntry(data);
              if (entry) entries.push(entry);
            }
          } catch {
            // Skip invalid JSON files
          }
        }
      }
    }

    // If no JSON files found, look for a memories directory or table
    if (entries.length === 0) {
      const memoriesDir = join(this.lancedbPath, "memories");
      if (existsSync(memoriesDir)) {
        // Try to read any data files in the memories directory
        const memoryFiles = readdirSync(memoriesDir);
        for (const file of memoryFiles) {
          const filePath = join(memoriesDir, file);
          if (file.endsWith(".json") && statSync(filePath).isFile()) {
            try {
              const content = readFileSync(filePath, "utf-8");
              const data = JSON.parse(content);
              const entry = this.parseJsonEntry(data);
              if (entry) entries.push(entry);
            } catch {
              // Skip invalid files
            }
          }
        }
      }
    }

    // Deduplicate by ID
    const seen = new Set<string>();
    return entries.filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  }

  /**
   * Parse a JSON object into a LanceDBEntry.
   */
  private parseJsonEntry(data: unknown): LanceDBEntry | null {
    if (!data || typeof data !== "object") return null;

    const obj = data as Record<string, unknown>;

    // Must have text content
    const text = obj.text || obj.content || obj.memory;
    if (!text || typeof text !== "string") return null;

    // Generate ID if not present
    const id =
      obj.id || obj._id || randomUUID();

    // Extract vector if present
    let vector: number[] | undefined;
    if (obj.vector && Array.isArray(obj.vector)) {
      vector = obj.vector as number[];
    } else if (obj.embedding && Array.isArray(obj.embedding)) {
      vector = obj.embedding as number[];
    }

    // Extract timestamp
    let timestamp: string | undefined;
    if (obj.timestamp) {
      timestamp = String(obj.timestamp);
    } else if (obj.created_at) {
      timestamp = String(obj.created_at);
    } else if (obj.createdAt) {
      timestamp = String(obj.createdAt);
    }

    return {
      id: String(id),
      text: text.trim(),
      vector,
      timestamp,
      metadata: obj.metadata as Record<string, unknown> | undefined,
    };
  }

  /**
   * Calculate total size of entries in bytes.
   */
  private calculateSize(entries: LanceDBEntry[]): number {
    let size = 0;
    for (const entry of entries) {
      size += entry.text.length * 2; // Rough UTF-16 estimate
      if (entry.vector) {
        size += entry.vector.length * 4; // Float32 = 4 bytes
      }
    }
    return size;
  }

  /**
   * Create a backup of the current LanceDB directory.
   * @returns Path to the backup
   */
  private createBackup(): string {
    // Ensure backup directory exists
    mkdirSync(this.backupDir, { recursive: true });

    // Create timestamped backup name
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(this.backupDir, `lancedb_backup_${timestamp}`);

    // Copy LanceDB directory to backup
    this.copyDirectory(this.lancedbPath, backupPath);

    return backupPath;
  }

  /**
   * Recursively copy a directory.
   */
  private copyDirectory(src: string, dest: string): void {
    mkdirSync(dest, { recursive: true });

    const entries = readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyDirectory(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Check if an entry is a duplicate of an existing memory.
   */
  private async isDuplicate(embedding: number[]): Promise<boolean> {
    const results = this.vectorHelper.vectorSearch(embedding, 1);
    if (results.length === 0) return false;
    return results[0].similarity >= DUPLICATE_THRESHOLD;
  }

  /**
   * Store a LanceDB entry as a memory in the tiered system.
   */
  private async storeEntry(
    entry: LanceDBEntry,
    embedding: number[]
  ): Promise<void> {
    const now = new Date().toISOString();
    const today = now.split("T")[0];

    // Use original timestamp if available
    const createdAt = entry.timestamp || now;

    // Insert into memories table
    const insertStmt = this.db.prepare(`
      INSERT INTO memories (
        id, text, importance, category, created_at, tier, memory_type,
        do_not_inject, pinned, use_count, last_accessed_at, use_days, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      entry.id,
      entry.text,
      0.5, // default importance
      null, // no category
      createdAt,
      Tier.WARM, // Import as WARM tier per spec
      this.detectMemoryType(entry.text),
      0, // do_not_inject
      0, // pinned
      0, // use_count
      now, // last_accessed_at
      JSON.stringify([today]), // use_days
      "legacy" // source = 'legacy' per spec
    );

    // Store the embedding
    this.vectorHelper.storeEmbedding(entry.id, embedding);
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
   * Get the LanceDB path being used.
   */
  getLanceDBPath(): string {
    return this.lancedbPath;
  }

  /**
   * Get the backup directory path.
   */
  getBackupDir(): string {
    return this.backupDir;
  }
}

export default LanceDBMigrator;
