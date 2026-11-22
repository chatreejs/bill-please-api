import { opentelemetry } from '@elysiajs/opentelemetry';
import {
  type Attributes,
  context,
  type Context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { Elysia } from 'elysia';

import { getLogger } from './logger.ts';

const log = getLogger('telemetry');

/** Paths that probes and open web pages poll. They get no trace. */
export const POLLED_PATHS = new Set(['/health', '/livez', '/readyz', '/api/receipts/status']);

// Get the tracer on each call. A tracer taken before startTelemetry() stays a no-op even after the SDK starts
const tracer = () => trace.getTracer('bill-please-api');
let sdk: NodeSDK | undefined;

/**
 * Starts the OpenTelemetry SDK when OTEL_EXPORTER_OTLP_ENDPOINT is set. The SDK reads the rest of
 * its settings from the standard OTEL_* variables, such as OTEL_SERVICE_NAME and
 * OTEL_RESOURCE_ATTRIBUTES. Without the endpoint the global tracer stays a no-op, so withSpan()
 * makes spans that record nothing, and tests send nothing.
 */
export const startTelemetry = () => {
  const endpoint = Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || sdk) return;
  sdk = new NodeSDK({ serviceName: Bun.env.OTEL_SERVICE_NAME || 'bill-please-api' });
  sdk.start();
  log.info(`Sending traces to ${endpoint}`);
};

/** Sends the spans that are still buffered. Call it before the process exits. */
export const stopTelemetry = async () => {
  await sdk?.shutdown().catch((error: unknown) => log.warn('Could not flush traces', error));
  sdk = undefined;
};

/**
 * An Elysia plugin that makes one server span per request, with a child span for each of Elysia's
 * lifecycle steps. It uses the SDK from startTelemetry(), and adds nothing when tracing is off.
 */
export const tracing = () =>
  sdk
    ? opentelemetry({
        serviceName: 'bill-please-api',
        checkIfShouldTrace: (request) => !POLLED_PATHS.has(new URL(request.url).pathname),
      })
    : new Elysia({ name: 'tracing-off' });

/**
 * Runs fn in a new active span, then ends it. If fn throws, it marks the span as failed and throws
 * the error again. parent defaults to the active context.
 */
export const withSpan = <T>(
  name: string,
  options: { kind?: SpanKind; attributes?: Attributes; parent?: Context },
  fn: (span: Span) => Promise<T>,
): Promise<T> =>
  tracer().startActiveSpan(
    name,
    { kind: options.kind ?? SpanKind.INTERNAL, attributes: options.attributes },
    options.parent ?? context.active(),
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        failSpan(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );

/** Starts a span that the caller ends, for a wait that starts and ends in different callbacks */
export const startSpan = (name: string, attributes: Attributes, parent: Context = context.active()) =>
  tracer().startSpan(name, { attributes }, parent);

export const failSpan = (span: Span, error: unknown) => {
  const err = error instanceof Error ? error : new Error(String(error));
  span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
};

/**
 * Returns headers with the W3C traceparent of the active span, for an outgoing call. bill-please-ocr
 * reads it, so its spans join this trace. Bun's fetch doesn't add it.
 */
export const traceHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  return headers;
};

export { context, SpanKind };
