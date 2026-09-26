import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Flush + release the file handle budget (no-op for console loggers). */
  close(): void;
}

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface FileLoggerOptions {
  /** Absolute path of the primary log file. Rotation renames to `<file>.1` … */
  file: string;
  /** Rotate when the active file passes this size. Default 5 MiB. */
  maxBytes?: number;
  /** Rotated files kept (log.1 … log.N). Default 3. */
  maxFiles?: number;
  /** Also write lines to stderr. Default true. */
  console?: boolean;
  level?: LogLevel;
}

const format = (
  level: LogLevel,
  message: string,
  fields?: Record<string, unknown>,
) =>
  `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}` +
  (fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "");

/**
 * Line logger writing to a rotating file (the issue's "log to file with
 * rotation"): on open and before writes past `maxBytes`, files shift
 * file.N → file.N+1 and the active file restarts.
 */
export function createFileLogger(options: FileLoggerOptions): Logger {
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 3;
  const toConsole = options.console ?? true;
  const minLevel = LEVELS[options.level ?? "info"];
  mkdirSync(dirname(options.file), { recursive: true });

  const rotate = () => {
    for (let i = maxFiles; i >= 1; i--) {
      const from = i === 1 ? options.file : `${options.file}.${i - 1}`;
      const to = `${options.file}.${i}`;
      if (existsSync(from)) renameSync(from, to);
    }
  };

  const write = (
    level: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ) => {
    if (LEVELS[level] < minLevel) return;
    const line = format(level, message, fields);
    if (toConsole) console.error(line);
    try {
      if (existsSync(options.file) && statSync(options.file).size > maxBytes) {
        rotate();
      }
      appendFileSync(options.file, `${line}\n`);
    } catch {
      // Logging must never take the harness down.
    }
  };

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    close: () => {},
  };
}

/** In-memory logger for tests. */
export function createMemoryLogger(sink?: LogLevel[]): Logger & {
  lines: string[];
} {
  const lines: string[] = [];
  const write = (
    level: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ) => {
    if (sink && !sink.includes(level)) return;
    lines.push(format(level, message, fields));
  };
  return {
    lines,
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    close: () => {},
  };
}
