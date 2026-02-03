/**
 * TuningReporter - Notification delivery for tuning changes.
 *
 * Features:
 *   - Formats tuning change notifications with parameter, old/new values, reason, stats
 *   - Delivers via configured channel (telegram, discord, slack, log, none)
 *   - Supports multiple frequencies:
 *     - on-change: immediate notification
 *     - daily-summary: batches changes, sends once per day
 *     - weekly-summary: batches changes, sends once per week
 *   - Respects reporting.enabled setting
 */

import type { Database as SqliteDb } from "better-sqlite3";
import type { ResolvedConfig, ReportingChannelValue, ReportingFrequencyValue } from "../config.js";
import type { TuningAdjustment, TierCounts } from "../core/tuning.js";

/**
 * A formatted notification message
 */
export interface NotificationMessage {
  /** Subject/title for the notification */
  subject: string;
  /** Body text of the notification */
  body: string;
  /** Timestamp when the notification was created */
  createdAt: string;
}

/**
 * Pending notification for batched delivery
 */
export interface PendingNotification {
  /** The adjustment that was made */
  adjustment: TuningAdjustment;
  /** Tier counts at the time of adjustment */
  tierCounts: TierCounts;
  /** When the adjustment occurred */
  timestamp: string;
}

/**
 * Result from sending a notification
 */
export interface NotificationResult {
  /** Whether the notification was sent successfully */
  success: boolean;
  /** Channel the notification was sent to */
  channel: ReportingChannelValue;
  /** Error message if sending failed */
  error?: string;
  /** Whether the notification was batched for later delivery */
  batched?: boolean;
}

/**
 * TuningReporter handles notification delivery for tuning changes.
 */
export class TuningReporter {
  private db: SqliteDb;
  private config: ResolvedConfig;
  private pendingNotifications: PendingNotification[] = [];
  private lastDailySummary: Date | null = null;
  private lastWeeklySummary: Date | null = null;

  /**
   * Create a new TuningReporter instance.
   * @param db - The better-sqlite3 database instance
   * @param config - Resolved plugin configuration
   */
  constructor(db: SqliteDb, config: ResolvedConfig) {
    this.db = db;
    this.config = config;
  }

  /**
   * Report a tuning adjustment.
   * Handles immediate or batched delivery based on frequency setting.
   * @param adjustment - The adjustment that was made
   * @param tierCounts - Current tier counts for stats
   * @returns Result of the notification attempt
   */
  report(adjustment: TuningAdjustment, tierCounts: TierCounts): NotificationResult {
    // Skip if reporting is disabled
    if (!this.config.reporting.enabled) {
      return { success: true, channel: "none", batched: false };
    }

    // Skip if channel is none
    if (this.config.reporting.channel === "none") {
      return { success: true, channel: "none", batched: false };
    }

    const now = new Date();
    const timestamp = now.toISOString();

    // Handle based on frequency
    switch (this.config.reporting.frequency) {
      case "on-change":
        return this.sendImmediate(adjustment, tierCounts, timestamp);

      case "daily-summary":
        this.pendingNotifications.push({ adjustment, tierCounts, timestamp });
        // Check if we should send daily summary
        if (this.shouldSendDailySummary(now)) {
          return this.sendDailySummary(now);
        }
        return { success: true, channel: this.config.reporting.channel, batched: true };

      case "weekly-summary":
        this.pendingNotifications.push({ adjustment, tierCounts, timestamp });
        // Check if we should send weekly summary
        if (this.shouldSendWeeklySummary(now)) {
          return this.sendWeeklySummary(now);
        }
        return { success: true, channel: this.config.reporting.channel, batched: true };

      default:
        return this.sendImmediate(adjustment, tierCounts, timestamp);
    }
  }

  /**
   * Send an immediate notification for a single adjustment.
   */
  private sendImmediate(
    adjustment: TuningAdjustment,
    tierCounts: TierCounts,
    timestamp: string
  ): NotificationResult {
    const message = this.formatSingleNotification(adjustment, tierCounts, timestamp);
    return this.deliver(message);
  }

  /**
   * Check if we should send the daily summary.
   * Returns true if we're on a new day since the last summary was sent.
   * If no summary has been sent yet, we wait until the next day boundary.
   */
  private shouldSendDailySummary(now: Date): boolean {
    // If no summary has been sent yet, don't auto-send (wait for manual flush or time boundary)
    if (!this.lastDailySummary) {
      return false;
    }

    // Check if we're on a new day
    const lastDate = this.lastDailySummary.toDateString();
    const currentDate = now.toDateString();
    return lastDate !== currentDate && this.pendingNotifications.length > 0;
  }

  /**
   * Check if we should send the weekly summary.
   * Returns true if we're on a new week since the last summary was sent.
   * If no summary has been sent yet, we wait until the next week boundary.
   */
  private shouldSendWeeklySummary(now: Date): boolean {
    // If no summary has been sent yet, don't auto-send (wait for manual flush or time boundary)
    if (!this.lastWeeklySummary) {
      return false;
    }

    // Check if we're on a new week (Monday start)
    const getWeekNumber = (date: Date) => {
      const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
      const dayNum = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    };

    const lastWeek = getWeekNumber(this.lastWeeklySummary);
    const currentWeek = getWeekNumber(now);
    const lastYear = this.lastWeeklySummary.getFullYear();
    const currentYear = now.getFullYear();

    return (lastYear !== currentYear || lastWeek !== currentWeek) && this.pendingNotifications.length > 0;
  }

  /**
   * Send a daily summary of all pending notifications.
   */
  private sendDailySummary(now: Date): NotificationResult {
    const message = this.formatSummaryNotification("Daily", this.pendingNotifications);
    const result = this.deliver(message);

    if (result.success) {
      this.pendingNotifications = [];
      this.lastDailySummary = now;
    }

    return result;
  }

  /**
   * Send a weekly summary of all pending notifications.
   */
  private sendWeeklySummary(now: Date): NotificationResult {
    const message = this.formatSummaryNotification("Weekly", this.pendingNotifications);
    const result = this.deliver(message);

    if (result.success) {
      this.pendingNotifications = [];
      this.lastWeeklySummary = now;
    }

    return result;
  }

  /**
   * Force flush any pending notifications.
   * Useful for testing or on shutdown.
   */
  flushPending(): NotificationResult | null {
    if (this.pendingNotifications.length === 0) {
      return null;
    }

    const periodType = this.config.reporting.frequency === "daily-summary" ? "Daily" : "Weekly";
    const message = this.formatSummaryNotification(periodType, this.pendingNotifications);
    const result = this.deliver(message);

    if (result.success) {
      this.pendingNotifications = [];
      const now = new Date();
      if (this.config.reporting.frequency === "daily-summary") {
        this.lastDailySummary = now;
      } else {
        this.lastWeeklySummary = now;
      }
    }

    return result;
  }

  /**
   * Format a notification for a single adjustment.
   */
  formatSingleNotification(
    adjustment: TuningAdjustment,
    tierCounts: TierCounts,
    timestamp: string
  ): NotificationMessage {
    const subject = `TRAM Auto-Tuning: ${adjustment.parameter} changed`;

    let body = `**Parameter Change**\n`;
    body += `- Parameter: \`${adjustment.parameter}\`\n`;
    body += `- Old Value: \`${adjustment.oldValue}\`\n`;
    body += `- New Value: \`${adjustment.newValue}\`\n`;
    body += `- Reason: ${adjustment.reason}\n`;
    body += `- Time: ${timestamp}\n`;

    if (this.config.reporting.includeMetrics) {
      body += `\n**Current Tier Stats**\n`;
      body += `- HOT: ${tierCounts.hot}\n`;
      body += `- WARM: ${tierCounts.warm}\n`;
      body += `- COLD: ${tierCounts.cold}\n`;
      body += `- ARCHIVE: ${tierCounts.archive}\n`;
      body += `- Total: ${tierCounts.total}\n`;
    }

    return { subject, body, createdAt: timestamp };
  }

  /**
   * Format a summary notification for multiple adjustments.
   */
  formatSummaryNotification(
    periodType: "Daily" | "Weekly",
    notifications: PendingNotification[]
  ): NotificationMessage {
    const now = new Date().toISOString();
    const subject = `TRAM ${periodType} Tuning Summary: ${notifications.length} change(s)`;

    let body = `**${periodType} Tuning Summary**\n`;
    body += `Total changes: ${notifications.length}\n\n`;

    for (const notification of notifications) {
      body += `---\n`;
      body += `**${notification.adjustment.parameter}**\n`;
      body += `- Old: \`${notification.adjustment.oldValue}\` -> New: \`${notification.adjustment.newValue}\`\n`;
      body += `- Reason: ${notification.adjustment.reason}\n`;
      body += `- Time: ${notification.timestamp}\n`;

      if (this.config.reporting.includeMetrics) {
        body += `- Tiers at change: HOT=${notification.tierCounts.hot}, WARM=${notification.tierCounts.warm}, COLD=${notification.tierCounts.cold}\n`;
      }
    }

    // Add current summary stats if available
    if (notifications.length > 0 && this.config.reporting.includeMetrics) {
      const lastNotification = notifications[notifications.length - 1];
      body += `\n**Latest Tier Stats**\n`;
      body += `- HOT: ${lastNotification.tierCounts.hot}\n`;
      body += `- WARM: ${lastNotification.tierCounts.warm}\n`;
      body += `- COLD: ${lastNotification.tierCounts.cold}\n`;
      body += `- Total: ${lastNotification.tierCounts.total}\n`;
    }

    return { subject, body, createdAt: now };
  }

  /**
   * Deliver a notification via the configured channel.
   */
  private deliver(message: NotificationMessage): NotificationResult {
    const channel = this.config.reporting.channel;

    switch (channel) {
      case "log":
        return this.deliverToLog(message);
      case "telegram":
        return this.deliverToTelegram(message);
      case "discord":
        return this.deliverToDiscord(message);
      case "slack":
        return this.deliverToSlack(message);
      case "none":
        return { success: true, channel };
      default:
        return { success: false, channel, error: `Unknown channel: ${channel}` };
    }
  }

  /**
   * Deliver notification to console/log output.
   */
  private deliverToLog(message: NotificationMessage): NotificationResult {
    console.log(`[TRAM] ${message.subject}`);
    console.log(message.body);
    return { success: true, channel: "log" };
  }

  /**
   * Deliver notification to Telegram.
   * Note: Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID environment variables.
   */
  private deliverToTelegram(message: NotificationMessage): NotificationResult {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
      // Fall back to log if credentials not configured
      console.log(`[TRAM] Telegram not configured, falling back to log`);
      return this.deliverToLog(message);
    }

    // Asynchronously send to Telegram (fire and forget for now)
    const text = `*${message.subject}*\n\n${message.body}`;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
    }).catch((err) => {
      console.error(`[TRAM] Failed to send Telegram notification: ${err.message}`);
    });

    return { success: true, channel: "telegram" };
  }

  /**
   * Deliver notification to Discord webhook.
   * Note: Requires DISCORD_WEBHOOK_URL environment variable.
   */
  private deliverToDiscord(message: NotificationMessage): NotificationResult {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

    if (!webhookUrl) {
      // Fall back to log if credentials not configured
      console.log(`[TRAM] Discord not configured, falling back to log`);
      return this.deliverToLog(message);
    }

    // Asynchronously send to Discord (fire and forget for now)
    fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `**${message.subject}**\n\n${message.body}`,
      }),
    }).catch((err) => {
      console.error(`[TRAM] Failed to send Discord notification: ${err.message}`);
    });

    return { success: true, channel: "discord" };
  }

  /**
   * Deliver notification to Slack webhook.
   * Note: Requires SLACK_WEBHOOK_URL environment variable.
   */
  private deliverToSlack(message: NotificationMessage): NotificationResult {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;

    if (!webhookUrl) {
      // Fall back to log if credentials not configured
      console.log(`[TRAM] Slack not configured, falling back to log`);
      return this.deliverToLog(message);
    }

    // Asynchronously send to Slack (fire and forget for now)
    fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `*${message.subject}*\n\n${message.body}`,
      }),
    }).catch((err) => {
      console.error(`[TRAM] Failed to send Slack notification: ${err.message}`);
    });

    return { success: true, channel: "slack" };
  }

  /**
   * Get pending notification count (for testing/debugging).
   */
  getPendingCount(): number {
    return this.pendingNotifications.length;
  }
}

export default TuningReporter;
