import { createApp } from './app.ts';
import { config } from './config.ts';
import { configureLogger, getLogger } from './logger.ts';
import { createScanner } from './scanners/index.ts';
import { startTelemetry, stopTelemetry } from './telemetry.ts';

configureLogger({ level: config.logLevel });
const log = getLogger('main');
// Before createApp, so the app's tracing plugin finds the SDK
startTelemetry();

const app = createApp(config, createScanner(config)).listen(config.port);

log.info(
  `Started bill-please-api on port ${app.server?.port} ` +
    `(ocr=${config.ocrUrl}, llm=${config.llmModel}, logLevel=${config.logLevel}, bun=${Bun.version})`,
);
log.info('REST: POST /api/receipts/scan, GET /api/receipts/status, probes: GET /livez, GET /readyz');
log.debug(`CORS origins: ${config.corsOrigins.join(', ')}`);

const shutdown = (signal: string) => {
  log.info(`Received ${signal}, shutting down`);
  void app
    .stop()
    .then(stopTelemetry)
    .then(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
