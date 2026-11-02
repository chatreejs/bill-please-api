import { Elysia } from 'elysia';

import type { Config } from './config.ts';
import { getLogger, logContext } from './logger.ts';

const log = getLogger('http.access');

const REQUEST_ID_PATTERN = /^[\w-]{1,64}$/;

// Kubernetes liveness/readiness probes and the Docker HEALTHCHECK (wget)
const PROBE_USER_AGENT = /^(kube-probe|wget)\//i;

/**
 * Client IP, trusting proxy headers only behind our own reverse proxy. Traffic comes through
 * a Cloudflare tunnel, and Traefik replaces X-Forwarded-For with the cloudflared pod IP, so
 * CF-Connecting-IP, which Cloudflare sets to the visitor IP, comes first.
 */
export const clientIp = (
  request: Request,
  server: { requestIP: (request: Request) => { address: string } | null } | null,
  trustProxy: boolean,
) =>
  (trustProxy
    ? request.headers.get('cf-connecting-ip')?.trim() ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      undefined
    : undefined) ??
  server?.requestIP(request)?.address ??
  '';

/**
 * Assigns every request an id (reusing a sane incoming `X-Request-Id`), exposes
 * it to all loggers via `logContext`, echoes it back in the response header and
 * writes one access log record per request.
 */
export const requestLogger = (config: Config) =>
  new Elysia({ name: 'request-logger' })
    .onRequest(({ request, set, server }) => {
      const incoming = request.headers.get('x-request-id');
      const requestId =
        incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID().slice(0, 8);
      logContext.enterWith({
        requestId,
        startedAt: performance.now(),
        // Resolve now: Bun can no longer see the socket once the response is sent
        clientIp: clientIp(request, server, config.trustProxy),
      });
      set.headers['x-request-id'] = requestId;
    })
    .onError({ as: 'global' }, ({ code, error, request }) => {
      // Expected client errors (404, validation) are covered by the access log
      if (code === 'NOT_FOUND' || code === 'VALIDATION' || code === 'PARSE') return;
      log.error(`Unhandled error on ${request.method} ${new URL(request.url).pathname}`, error);
    })
    .onAfterResponse({ as: 'global' }, ({ request, set, responseValue }) => {
      const context = logContext.getStore();
      const path = new URL(request.url).pathname;
      const status =
        responseValue instanceof Response ? responseValue.status : Number(set.status ?? 200);
      const duration = context ? Math.round(performance.now() - context.startedAt) : 0;
      const userAgent = request.headers.get('user-agent') ?? '';
      const message = `${request.method} ${path} ${status} ${duration}ms`;
      const fields = {
        http: { method: request.method, path, status, durationMs: duration },
        clientIp: context?.clientIp || undefined,
        userAgent: userAgent || undefined,
      };

      // Infra probes call /health every few seconds, so they log at DEBUG. /health from the web logs at INFO.
      // Every open web page polls /api/receipts/status every few seconds, so it logs at DEBUG too
      const isProbe = PROBE_USER_AGENT.test(userAgent);
      const isPoll = (path === '/health' && isProbe) || path === '/api/receipts/status';
      if (isPoll && status < 400) log.debug(message, fields);
      else if (status >= 500) log.error(message, fields);
      else if (status >= 400) log.warn(message, fields);
      else log.info(message, fields);
    });
