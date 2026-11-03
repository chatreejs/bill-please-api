import { cors } from '@elysiajs/cors';
import { Elysia } from 'elysia';
import { rateLimit } from 'elysia-rate-limit';

import { type Config, corsOrigin } from './config.ts';
import { createReadinessCheck, type ReadinessCheck } from './health.ts';
import { mcpRoutes } from './mcp/route.ts';
import { clientIp, requestLogger } from './request-logger.ts';
import { receiptRoutes } from './routes/receipts.ts';
import type { ReceiptScanner } from './scanners/index.ts';
import { createTurnstileVerifier, type TurnstileVerifier } from './turnstile.ts';

const POLLED_PATHS = new Set(['/health', '/livez', '/readyz', '/api/receipts/status']);

export const createApp = (
  config: Config,
  scanner: ReceiptScanner,
  verifyTurnstile: TurnstileVerifier | undefined = createTurnstileVerifier({
    secretKey: config.turnstileSecretKey,
    hostnames: config.turnstileHostnames,
    timeoutMs: config.turnstileTimeoutMs,
  }),
  checkReadiness: ReadinessCheck = createReadinessCheck({
    ocrUrl: config.ocrUrl,
    llmUrl: config.llmUrl,
    llmApiKey: config.llmApiKey,
    timeoutMs: config.readinessTimeoutMs,
  }),
) =>
  new Elysia()
    .use(requestLogger(config))
    .use(cors({ origin: config.corsOrigins.map(corsOrigin) }))
    // Liveness: the process answers. It checks no dependency, so a down LLM never restarts the pod
    .get('/livez', () => ({ status: 'ok' }))
    // Same as /livez. The Helm chart probes it today, so it stays dependency free
    .get('/health', () => ({ status: 'ok' }))
    // Readiness: OCR and the LLM answer, so a scan could succeed now. 503 takes the pod out of the Service
    .get('/readyz', async ({ status }) => {
      const { ready, checks } = await checkReadiness();
      return ready ? { status: 'ok', checks } : status(503, { status: 'unavailable', checks });
    })
    .use(
      rateLimit({
        duration: 60_000,
        max: config.rateLimitPerMinute,
        // Probes poll /health, and every open web page keeps a status stream open and reconnects when it drops
        skip: (request) => POLLED_PATHS.has(new URL(request.url).pathname),
        generator: (request, server) => clientIp(request, server, config.trustProxy),
      }),
    )
    .use(receiptRoutes(config, scanner, verifyTurnstile))
    .use(mcpRoutes(config, scanner));
