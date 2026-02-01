/**
 * CLI command for migrating memory data from external sources.
 * Supports LanceDB migration with preview, progress bar, and rollback capability.
 */

import type { Database as SqliteDb } from "better-sqlite3";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { VectorHelper } from "../db/vectors.js";
import {
  LanceDBMigrator,
  type MigrationPreview,
  type MigrationResult,
} from "../migration/lancedb.js";

/**
 * Options for the migrate command.
 */
export interface MigrateOptions {
  /** Source to migrate from (currently only 'lancedb' supported) */
  from?: string;
  /** Preview mode - show plan without executing */
  preview?: boolean;
  /** Rollback to previous backup */
  rollback?: boolean;
  /** Output as JSON */
  json?: boolean;
}

/**
 * Result of the migrate command.
 */
export interface MigrateCommandResult {
  /** Action performed */
  action: "preview" | "migrate" | "rollback" | "error";
  /** Source being migrated */
  source: string;
  /** Preview data if in preview mode */
  preview?: MigrationPreview;
  /** Migration result if migrating */
  migration?: MigrationResult;
  /** Rollback result */
  rollback?: {
    success: boolean;
    message: string;
    backupRestored?: string;
  };
  /** Progress updates during migration */
  progressUpdates?: Array<{ current: number; total: number; percentage: number }>;
  /** Human-readable message */
  message: string;
}

/**
 * Progress bar renderer for terminal output.
 */
class ProgressBar {
  private width: number;
  private current: number = 0;
  private total: number = 0;
  private output: string[] = [];

  constructor(width: number = 40) {
    this.width = width;
  }

  /**
   * Update progress and return the progress bar string.
   */
  update(current: number, total: number): string {
    this.current = current;
    this.total = total;

    const percentage = Math.floor((current / total) * 100);
    const filled = Math.floor((current / total) * this.width);
    const empty = this.width - filled;

    const bar = "█".repeat(filled) + "░".repeat(empty);
    const line = `[${bar}] ${percentage}% (${current}/${total})`;

    this.output.push(line);
    return line;
  }

  /**
   * Get all progress output lines.
   */
  getOutput(): string[] {
    return this.output;
  }
}

/**
 * CLI command for migrating memory data from external sources.
 */
export class MemoryMigrateCommand {
  private db: SqliteDb;
  private embeddingProvider: EmbeddingProvider;
  private vectorHelper: VectorHelper;

  /**
   * Create a new MemoryMigrateCommand instance.
   * @param db - The better-sqlite3 database instance
   * @param embeddingProvider - Provider for generating embeddings
   * @param vectorHelper - Helper for vector storage and search
   */
  constructor(
    db: SqliteDb,
    embeddingProvider: EmbeddingProvider,
    vectorHelper: VectorHelper
  ) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    this.vectorHelper = vectorHelper;
  }

  /**
   * Execute the migrate command.
   * @param options - Migration options
   * @returns Formatted output string
   */
  async execute(options: MigrateOptions = {}): Promise<string> {
    const { from = "lancedb", preview = false, rollback = false, json = false } = options;

    // Validate source
    if (from !== "lancedb") {
      const result: MigrateCommandResult = {
        action: "error",
        source: from,
        message: `Unknown migration source: ${from}. Currently only 'lancedb' is supported.`,
      };
      return json ? JSON.stringify(result, null, 2) : result.message;
    }

    // Create migrator
    const migrator = new LanceDBMigrator(
      this.db,
      this.embeddingProvider,
      this.vectorHelper
    );

    // Handle rollback
    if (rollback) {
      const rollbackResult = migrator.rollback();
      const result: MigrateCommandResult = {
        action: "rollback",
        source: from,
        rollback: rollbackResult,
        message: rollbackResult.message,
      };
      return json ? JSON.stringify(result, null, 2) : this.formatRollbackOutput(result);
    }

    // Handle preview
    if (preview) {
      const previewData = await migrator.preview();
      const result: MigrateCommandResult = {
        action: "preview",
        source: from,
        preview: previewData,
        message: this.buildPreviewMessage(previewData),
      };
      return json ? JSON.stringify(result, null, 2) : this.formatPreviewOutput(result);
    }

    // Execute migration
    const progressBar = new ProgressBar(40);
    const progressUpdates: Array<{ current: number; total: number; percentage: number }> = [];

    const migrationResult = await migrator.migrate({
      onProgress: (current, total) => {
        const percentage = Math.floor((current / total) * 100);
        progressUpdates.push({ current, total, percentage });
        progressBar.update(current, total);
      },
    });

    const result: MigrateCommandResult = {
      action: "migrate",
      source: from,
      migration: migrationResult,
      progressUpdates,
      message: this.buildMigrationMessage(migrationResult),
    };

    return json ? JSON.stringify(result, null, 2) : this.formatMigrationOutput(result, progressBar);
  }

  /**
   * Build preview message.
   */
  private buildPreviewMessage(preview: MigrationPreview): string {
    if (!preview.detected) {
      return `LanceDB not detected at ${preview.lancedbPath}`;
    }
    return `Found ${preview.entryCount} entries (${this.formatBytes(preview.estimatedSize)}) in LanceDB`;
  }

  /**
   * Build migration result message.
   */
  private buildMigrationMessage(migration: MigrationResult): string {
    if (!migration.success) {
      return `Migration failed with ${migration.errors.length} errors`;
    }
    return `Successfully migrated ${migration.entriesMigrated} entries`;
  }

  /**
   * Format preview output for terminal.
   */
  private formatPreviewOutput(result: MigrateCommandResult): string {
    const lines: string[] = [];
    const preview = result.preview!;

    lines.push("╔════════════════════════════════════════╗");
    lines.push("║     LanceDB Migration Preview          ║");
    lines.push("╚════════════════════════════════════════╝");
    lines.push("");

    lines.push(`📂 Path: ${preview.lancedbPath}`);
    lines.push(`📊 Status: ${preview.detected ? "Detected" : "Not Found"}`);
    lines.push("");

    if (preview.detected) {
      lines.push(`📝 Entries: ${preview.entryCount}`);
      lines.push(`💾 Size: ${this.formatBytes(preview.estimatedSize)}`);
      lines.push("");

      if (preview.sampleEntries.length > 0) {
        lines.push("📋 Sample Entries:");
        for (const sample of preview.sampleEntries) {
          const vectorIcon = sample.hasVector ? "✓" : "✗";
          lines.push(`   • [${vectorIcon}] ${sample.text}`);
        }
        lines.push("");
      }

      if (preview.warnings.length > 0) {
        lines.push("⚠️  Warnings:");
        for (const warning of preview.warnings) {
          lines.push(`   • ${warning}`);
        }
        lines.push("");
      }

      lines.push("─────────────────────────────────────────");
      lines.push("To execute migration, run:");
      lines.push("  memory migrate --from lancedb");
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Format migration output for terminal.
   */
  private formatMigrationOutput(
    result: MigrateCommandResult,
    progressBar: ProgressBar
  ): string {
    const lines: string[] = [];
    const migration = result.migration!;

    lines.push("╔════════════════════════════════════════╗");
    lines.push("║     LanceDB Migration Results          ║");
    lines.push("╚════════════════════════════════════════╝");
    lines.push("");

    // Show final progress bar
    if (result.progressUpdates && result.progressUpdates.length > 0) {
      const last = result.progressUpdates[result.progressUpdates.length - 1];
      lines.push(`Progress: ${progressBar.update(last.current, last.total)}`);
      lines.push("");
    }

    lines.push(
      `${migration.success ? "✅" : "❌"} Status: ${migration.success ? "Success" : "Failed"}`
    );
    lines.push(`📝 Migrated: ${migration.entriesMigrated}`);
    lines.push(`⏭️  Skipped: ${migration.entriesSkipped} (duplicates)`);
    lines.push(`❌ Failed: ${migration.entriesFailed}`);
    lines.push("");

    if (migration.backupPath) {
      lines.push(`💾 Backup: ${migration.backupPath}`);
      lines.push("");
    }

    if (migration.errors.length > 0) {
      lines.push("⚠️  Errors:");
      for (const error of migration.errors.slice(0, 10)) {
        lines.push(`   • ${error}`);
      }
      if (migration.errors.length > 10) {
        lines.push(`   ... and ${migration.errors.length - 10} more errors`);
      }
      lines.push("");
    }

    lines.push(`🕐 Completed: ${migration.migratedAt}`);
    lines.push("");

    if (!migration.success) {
      lines.push("─────────────────────────────────────────");
      lines.push("To rollback to previous state, run:");
      lines.push("  memory migrate --from lancedb --rollback");
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Format rollback output for terminal.
   */
  private formatRollbackOutput(result: MigrateCommandResult): string {
    const lines: string[] = [];
    const rollback = result.rollback!;

    lines.push("╔════════════════════════════════════════╗");
    lines.push("║     LanceDB Migration Rollback         ║");
    lines.push("╚════════════════════════════════════════╝");
    lines.push("");

    lines.push(
      `${rollback.success ? "✅" : "❌"} Status: ${rollback.success ? "Success" : "Failed"}`
    );
    lines.push(`📝 Message: ${rollback.message}`);

    if (rollback.backupRestored) {
      lines.push(`💾 Restored from: ${rollback.backupRestored}`);
    }

    lines.push("");

    return lines.join("\n");
  }

  /**
   * Format bytes to human-readable string.
   */
  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}

export default MemoryMigrateCommand;
