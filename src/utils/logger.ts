/**
 * @file logger.ts
 * @description Phase 21: Production Structured Logger
 *
 * Implements production-safe JSON logging with:
 * - Automatic sensitive data redaction (zero private key, secret, or password leakage)
 * - Structured log levels: DEBUG, INFO, WARN, ERROR
 * - Production ISO-8601 timestamps and component tags
 */

import { scrubSensitiveData } from "../api/framework/middleware";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "WARNING" | "ERROR" | "CRITICAL";

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  WARNING: 3,
  ERROR: 4,
  CRITICAL: 5,
};

export class Logger {
  private readonly context: string;
  private readonly minLevel: LogLevel;

  constructor(context: string = "App") {
    this.context = context;
    const envLevel = (process.env.LOG_LEVEL || "INFO").toUpperCase() as LogLevel;
    this.minLevel = LOG_LEVELS[envLevel] !== undefined ? envLevel : "INFO";
  }

  private shouldLog(level: LogLevel): boolean {
    // In production, suppress DEBUG unless explicitly enabled
    if (process.env.NODE_ENV === "production" && level === "DEBUG" && process.env.DEBUG !== "true") {
      return false;
    }
    return LOG_LEVELS[level] >= LOG_LEVELS[this.minLevel];
  }

  private formatMessage(level: LogLevel, message: string, data?: any): string {
    const entry: Record<string, any> = {
      timestamp: new Date().toISOString(),
      level: level === "WARN" ? "WARNING" : level,
      context: this.context,
      message,
    };

    if (data !== undefined) {
      entry.data = scrubSensitiveData(data);
    }

    return JSON.stringify(entry);
  }

  public debug(message: string, data?: any): void {
    if (this.shouldLog("DEBUG")) {
      console.debug(this.formatMessage("DEBUG", message, data));
    }
  }

  public info(message: string, data?: any): void {
    if (this.shouldLog("INFO")) {
      console.info(this.formatMessage("INFO", message, data));
    }
  }

  public warn(message: string, data?: any): void {
    if (this.shouldLog("WARN")) {
      console.warn(this.formatMessage("WARNING", message, data));
    }
  }

  public warning(message: string, data?: any): void {
    this.warn(message, data);
  }

  public error(message: string, error?: any, data?: any): void {
    if (this.shouldLog("ERROR")) {
      const errorData = {
        errorMessage: error?.message || String(error),
        stack: process.env.NODE_ENV === "production" ? undefined : error?.stack,
        ...(data || {}),
      };
      console.error(this.formatMessage("ERROR", message, errorData));
    }
  }

  public critical(message: string, error?: any, data?: any): void {
    if (this.shouldLog("CRITICAL")) {
      const errorData = {
        errorMessage: error?.message || String(error),
        stack: process.env.NODE_ENV === "production" ? undefined : error?.stack,
        ...(data || {}),
      };
      console.error(this.formatMessage("CRITICAL", message, errorData));
    }
  }
}

export const logger = new Logger("System");
