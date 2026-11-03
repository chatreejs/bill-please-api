import { cors } from '@elysiajs/cors';
import { Elysia } from 'elysia';
import { rateLimit } from 'elysia-rate-limit';

import { type Config, corsOrigin } from './config.ts';
import { createDependencyMonitor, createReadinessCheck, type DependencyMonitor } from './health.ts';
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
  dependencies: DependencyMonitor = createDependencyMonitor(
    createReadinessCheck({
      ocrUrl: config.ocrUrl,
      llmUrl: config.llmUrl,
      llmApiKey: config.llmApiKey,
      timeoutMs: config.readinessTimeoutMs,
    }),
  ),
) =>
  new Elysia()
    // Check OCR and the LLM in the background while the server listens. app.handle() in tests never starts the monitor
    .onStart(() => dependencies.start())
    .onStop(() => dependencies.stop())
    .use(requestLogger(config))
    .use(cors({ origin: config.corsOrigins.map(corsOrigin) }))
    // Liveness probe. It checks no dependency, so a down LLM never restarts the pod
    .get('/livez', () => ({ status: 'ok' }))
    // Same as /livez. The Helm chart probes it today, so it stays dependency free
    .get('/health', () => ({ status: 'ok' }))
    // Readiness probe. It answers 503 while OCR or the LLM is down, and Kubernetes then stops routing to the pod
    .get('/readyz', async ({ status }) => {
      const { ready, checks } = await dependencies.check();
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
    .use(receiptRoutes(config, scanner, dependencies, verifyTurnstile))
    .use(mcpRoutes(config, scanner, dependencies));
