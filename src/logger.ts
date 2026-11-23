import { AsyncLocalStorage } from 'node:async_hooks';

import { isSpanContextValid, trace } from '@opentelemetry/api';

/**
 * Minimal JSON logger. Every record is one JSON object on one line:
 *   {"time":"2026-10-30T14:03:12.345Z","level":"info","service":"bill-please-api","logger":"receipts.route","traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"00f067aa0ba902b7","msg":"Scanned receipt with 4 items"}
 * Plain object arguments become fields of the record, and an Error becomes the `error` field.
 * A record written inside an OpenTelemetry span also has `traceId` and `spanId`. Grafana uses
 * `traceId` to link the log line in Loki to its trace in Tempo.
 */

export const LOG_LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'OFF'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Record<LogLevel, number> = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  OFF: 5,
};

export interface LoggerOptions {
  level: LogLevel;
  service: string;
  /** Where JSON lines go; defaults to stdout/stderr */
  write: (line: string, level: LogLevel) => void;
}

const defaultWrite = (line: string, level: LogLevel) => {
  if (SEVERITY[level] >= SEVERITY.WARN) process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};

const options: LoggerOptions = {
  level: 'INFO',
  service: 'bill-please-api',
  write: defaultWrite,
};

export const configureLogger = (overrides: Partial<LoggerOptions>) => {
  Object.assign(options, overrides);
};

export const parseLogLevel = (value: string | undefined, fallback: LogLevel = 'INFO'): LogLevel => {
  const upper = value?.trim().toUpperCase();
  return (LOG_LEVELS as readonly string[]).includes(upper ?? '') ? (upper as LogLevel) : fallback;
};

/** Per-request state that the access log reads when the response is done */
export interface LogContext {
  startedAt: number;
  clientIp?: string;
}

export const logContext = new AsyncLocalStorage<LogContext>();

export interface SerializedError {
  type: string;
  message: string;
  stack?: string;
  cause?: SerializedError;
}

const serializeError = (error: Error): SerializedError => ({
  type: error.name,
  message: error.message,
  ...(error.stack ? { stack: error.stack } : {}),
  ...(error.cause instanceof Error ? { cause: serializeError(error.cause) } : {}),
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const stringify = (base: Record<string, unknown>, fields: Record<string, unknown>) => {
  try {
    return JSON.stringify({ ...base, ...fields });
  } catch {
    // Circular or BigInt fields: keep the record and inspect the fields as text
    return JSON.stringify({ ...base, fields: Bun.inspect(fields, { depth: 2 }).replace(/\s*\n\s*/g, ' ') });
  }
};

export interface Logger {
  trace: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  isEnabled: (level: LogLevel) => boolean;
}

export const getLogger = (name: string): Logger => {
  const isEnabled = (level: LogLevel) =>
    level !== 'OFF' && SEVERITY[level] >= SEVERITY[options.level];

  const log =
    (level: LogLevel) =>
    (message: string, ...args: unknown[]) => {
      if (!isEnabled(level)) return;

      const span = trace.getActiveSpan()?.spanContext();
      const fields: Record<string, unknown> = {};
      const extras: unknown[] = [];
      for (const arg of args) {
        if (arg instanceof Error) fields.error = serializeError(arg);
        else if (isPlainObject(arg)) Object.assign(fields, arg);
        else extras.push(arg);
      }

      options.write(
        stringify(
          {
            time: new Date().toISOString(),
            level: level.toLowerCase(),
            service: options.service,
            logger: name,
            ...(span && isSpanContextValid(span) ? { traceId: span.traceId, spanId: span.spanId } : {}),
            msg: message,
          },
          { ...fields, ...(extras.length ? { args: extras } : {}) },
        ),
        level,
      );
    };

  return {
    trace: log('TRACE'),
    debug: log('DEBUG'),
    info: log('INFO'),
    warn: log('WARN'),
    error: log('ERROR'),
    isEnabled,
  };
};
