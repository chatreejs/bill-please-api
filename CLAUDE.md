# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun dev               # dev server on localhost:3001, restarts on change
bun start             # run without watch mode
bun test              # bun:test suite in test/
bun run check-types   # tsc --noEmit
bun run inspect       # MCP Inspector; choose Streamable HTTP and http://localhost:3001/mcp
```

asdf installs Bun, and `.tool-versions` pins it to `bun 1.4.3`. For local config, copy `.env.example` to `.env`. There is no linter or formatter yet.

## Purpose

This is the backend for [bill-please](../bill-please), a client-only React PWA that splits restaurant bills. It turns a receipt photo into structured bill items. One server exposes the same scanner in two ways:

| Endpoint                  | Protocol                                   | Consumer                                                                  |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| `POST /api/receipts/scan` | REST, `multipart/form-data`, fields `image` and `cf-turnstile-response` | bill-please web                              |
| `/mcp`                    | MCP Streamable HTTP, stateless             | AI clients such as Claude, ChatGPT and Cursor                             |
| `GET /api/receipts/status` | REST                                      | bill-please web polls it to enable the "Add from bill" button, `busy` disables it |
| `GET /health`             | REST                                       | Docker healthcheck and Kubernetes probes |

## Architecture

```
src/
  index.ts            entry point: createApp(config, createScanner(config)).listen()
  app.ts              Elysia app, in order: requestLogger, cors, /health, rateLimit, receipt routes, mcp routes
  config.ts           parses Bun.env into the `config` object
  logger.ts           JSON lines logger: getLogger(name), LOG_LEVEL, logContext (AsyncLocalStorage per request)
  request-logger.ts   Elysia plugin: X-Request-Id, one access log record per request, unhandled errors; clientIp()
  schemas/receipt.ts  zod contract: ReceiptItemSchema, ReceiptScanResultSchema, SUPPORTED_IMAGE_TYPES
  scanners/
    types.ts          ReceiptScanner interface { scan(image): ReceiptScanResult }, ReceiptImage
    index.ts          createScanner(config) builds the OCR and LLM scanner, and scanReceiptImage()
    errors.ts         UnreadableReceiptError: no usable text in the image (REST 422), ScannerBusyError: LLM queue full or wait timed out (REST 503)
    ocr-llm-scanner.ts OcrLlmReceiptScanner: OCR, then LLM, then post-processing and a total check
    ocr-client.ts     HttpOcrClient for bill-please-ocr POST /v1/ocr, forwards X-Request-Id
    llm-client.ts     OpenAiCompatibleExtractor: chat completions with a GBNF grammar or a json_schema response_format
    llm-queue.ts      ConcurrencyLimiter (FIFO, LLM_MAX_CONCURRENT slots) and QueuedExtractor, which wraps the extractor
    extraction.ts     compact LLM output schema (zod), its JSON schema and its GBNF grammar
    prompt.ts         system prompt with one short example
    postprocess.ts    toReceiptItems (compact output to the contract), resolveRates and reconcile (vs printed total)
  turnstile.ts        createTurnstileVerifier(): Cloudflare siteverify check, undefined without a secret key
  routes/receipts.ts  GET /status (LLM queue state) and the REST scan route: 403/503 for Turnstile, 415 for a bad mime type, 413 for size, 502 for a scanner failure
  mcp/
    server.ts         createMcpServer() registers the tool `scan_receipt`
    route.ts          `/mcp` route using WebStandardStreamableHTTPServerTransport
test/app.test.ts      tests through app.handle(new Request(...)), without a real port
test/scanner.test.ts  OCR and LLM scanner with a stub OCR client and extractor, no network
test/turnstile.test.ts Turnstile on the scan route with a stub siteverify fetch, no network
test/llm-queue.test.ts the LLM queue, and the 503 and isError answers when it is busy
```

Key points:

- **Dependency injection.** `createApp(config, scanner)` takes the scanner, so tests pass a stub scanner or a broken one. New routes follow the same `xxxRoutes(config, scanner)` plugin pattern.
- **Contract validation.** Always call the scanner through `scanReceiptImage(scanner, image)`. It runs `zod.parse` on the scanner output, so a misbehaving AI model can never return malformed items. The REST route turns the error into a 502, and MCP returns `isError`.
- **Scanner.** `OcrLlmReceiptScanner` is the only scanner. It sends the photo to bill-please-ocr and only the OCR text to the LLM.
  - The LLM returns a compact shape to save tokens: items as `[name, quantity, line amount, category]`, plus receipt-level `servicePercent`, `vatPercent`, `vatIncluded` and the printed `total`. `toReceiptItems` divides the amount by the quantity and puts the receipt rates on every item, discounts included, so the web total equals the receipt total.
  - A VAT-inclusive receipt keeps its printed prices and gets no `vatPercentage`. This follows the recommendation in the local docs. The user hasn't confirmed it yet.
  - Small models misread the receipt-level rates. They read a VAT-inclusive receipt that prints a pre-VAT amount and a VAT line as VAT on top (bill-4 in the ocr fixtures), and Qwen3 4B returns no rate for "TAX 6%" (bill-2). When the items don't add up to the printed total, `resolveRates` tries the service and tax rates printed in the OCR text, with VAT on top and included, and keeps the first reading that matches. In the local benchmark every model got `vatIncluded` wrong on bill-4 or bill-2 in all 3 runs, so in practice this check decides.
  - `toReceiptItems` moves a quantity column the model left in the name ("4.00 F1.Water") into the quantity.
  - `reconcile` prices the items the way the web does and logs WARN when they don't match the printed total, or when there is no printed total, which counts as unchecked. There is no retry or fallback yet.
  - When OCR finds no lines, the mean confidence is under `OCR_MIN_CONFIDENCE`, or the LLM finds no items, the scanner throws `UnreadableReceiptError` without calling the LLM. REST answers 422, and MCP returns a friendly `isError`.
  - **LLM queue.** `createScanner` wraps the extractor in `QueuedExtractor`, so at most `LLM_MAX_CONCURRENT` scans call the LLM at once and the rest wait first in, first out. Only the LLM step queues; OCR runs before it without a limit. A scan that finds `LLM_QUEUE_MAX` scans already waiting, or waits longer than `LLM_QUEUE_TIMEOUT_MS`, throws `ScannerBusyError`. REST answers 503 with `Retry-After: 15`, and MCP returns a busy `isError`. The REST route passes `request.signal` and MCP passes `extra.signal` down through `scan(image, signal)`, so a client that goes away leaves the queue and aborts its LLM call. The queue lives in memory per process, like the rate limiter. `GET /api/receipts/status` answers `{ status: 'ok', busy, queue: { active, waiting, maxConcurrent, maxQueue } }`. `busy` is true when a new scan would get the queue-full 503 right now. The rate limit skips it and the access log writes it at DEBUG only, because every open web page polls it. The queue logs `Waiting for an LLM slot at position N`, `Got an LLM slot after waiting Nms` (`queue.waitMs`), and WARN records when it rejects a scan or gives up waiting.
  - On 2026-11-02 the cluster llm-server (llama.cpp `--parallel 1`, Qwen3 4B on the T400) took about 12 s for a 10-item receipt with a warm prompt cache. It runs concurrent requests one after another inside llama.cpp, with latencies of 12, 25, 38 and 50 s for 4 requests at once, so the right `LLM_MAX_CONCURRENT` is 1. Raising it only helps after `llmServer.server.parallel` goes up, and each extra slot shares the 4096-token context.
  - llama.cpp rejects boolean subschemas, so `extraction.ts` strips the `items: false` that zod adds to tuples.
- **MCP transport.** The route uses the SDK's `WebStandardStreamableHTTPServerTransport`, which takes a Request and returns a Response, so it fits Elysia without a community MCP plugin. It runs in stateless mode (`sessionIdGenerator: undefined`, `enableJsonResponse: true`) and creates a fresh `McpServer` and transport per request, closed in `finally`. The route must keep `{ parse: 'none' }`, otherwise Elysia consumes the body before the transport reads it.
- **MCP tool `scan_receipt`.** Its input is `{ imageBase64, mimeType }` and its `outputSchema` is `ReceiptScanResultSchema.shape`. It returns both `structuredContent` and a JSON `text` content, and has the `readOnlyHint` annotation.
- **Logging.** Never use `console.*`. Use `const log = getLogger('area.name')` from `src/logger.ts`, which has no dependencies.
  - Every record is one JSON object on one line: `time` (UTC ISO), `level` (lowercase), `service`, `logger`, `requestId` (only inside a request) and `msg`. Plain object arguments are merged into the record as fields. An Error becomes `error: { type, message, stack, cause }`. Any other argument goes into `args`. If a field can't be serialized, it is written as inspected text, so the record is never lost.
  - The request id comes from `logContext`. `onRequest` sets it with `enterWith`, so it follows async calls without being passed around. The server reuses a valid incoming `X-Request-Id` and always sends it back.
  - A scan logs one INFO record per step, with the numbers in fields: `Received receipt image` or `scan_receipt called` (`image`), `Calling OCR` (`ocr.url`), `OCR complete` (`ocr.lines`, `meanConfidence`, `durationMs` inside the OCR service, `elapsedMs` including the upload), `Calling LLM` (`llm.model`, `outputFormat`, `ocrChars`), `LLM complete` (`llm.elapsedMs`, `promptTokens`, `completionTokens`, `finishReason`), the rate fix when `resolveRates` changes anything (`rates.model`, `rates.resolved`), `Extracted N items` (`total`) and `Scan complete` (`scan.items`, `scan.elapsedMs`).
  - The access log record has the message `METHOD path status Nms` and the fields `http: { method, path, status, durationMs }`, `clientIp` and `userAgent`. 2xx and 3xx log at INFO, 4xx at WARN and 5xx at ERROR. `/health` from infra probes (User-Agent `kube-probe/*` or `Wget/*`) and `/api/receipts/status` log only at DEBUG. `/health` from anything else logs at INFO.
  - `onRequest` resolves the client IP, because Bun can't see the socket after the response.
  - Never log image bytes or secrets. Tests capture output with `configureLogger({ write })`.
- **Turnstile.** `POST /api/receipts/scan` checks the single-use `cf-turnstile-response` token from bill-please web with Cloudflare's siteverify before any OCR or LLM work. It sends the client IP from `clientIp()` as `remoteip`. It answers 403 when the token is missing or rejected, the action isn't `receipt_scan`, or the hostname isn't in `TURNSTILE_HOSTNAMES`, and 503 when siteverify can't be reached (fail closed). Results from Cloudflare's test secret keys (`metadata.result_with_testing_key`) skip the action and hostname checks, because they always answer hostname `example.com` and no action. Without `TURNSTILE_SECRET_KEY` the check is off, like the web without `VITE_APP_TURNSTILE_SITE_KEY`. `createApp` takes the verifier as an optional third argument so tests can stub `fetch`. `/mcp` has no Turnstile, because AI clients can't run the widget; only the rate limit covers it.
- **Rate limiting.** It uses `elysia-rate-limit` v4. v5 needs Elysia 2, which is still in beta, so stay on Elysia 1.4. The limit is in memory per process and skips `/health` and `/api/receipts/status`. When `TRUST_PROXY=true`, the client IP comes from `CF-Connecting-IP`, then the first `X-Forwarded-For` entry. Traffic arrives through a Cloudflare tunnel, and Traefik replaces `X-Forwarded-For` with the cloudflared pod IP, so only `CF-Connecting-IP` has the visitor IP.

## Contract with bill-please web (keep in sync)

`src/schemas/receipt.ts` mirrors `IReceiptItem` and `IReceiptScanResult` in `../bill-please/src/interfaces/receipt.ts`:

```json
{
  "items": [
    {
      "name": "Pad Thai",
      "quantity": 2,
      "price": 120,
      "servicePercentage": 10,
      "vatPercentage": 7,
      "category": "food"
    },
    { "name": "Member Discount", "quantity": 1, "price": -200 }
  ]
}
```

- `price` is the unit price before service charge and VAT. It can be negative for discounts.
- `name` is the printed name with OCR errors fixed by the LLM. It keeps the receipt's language and menu codes.
- `category` is optional, one of `food`, `drink`, `alcohol`, `dessert` or `other` (`ITEM_CATEGORIES`). Discounts have none. bill-please web doesn't read it yet.
- `servicePercentage` and `vatPercentage` are per item, not per bill. That is a user decision. Both are optional and default to 0.
- The web converts items with `receiptItemToBillItem` in `../bill-please/src/utils/bill.util.ts`. Service is price × quantity × service %, and VAT is (price × quantity + service) × VAT %. Its manual item form uses the same formula.
- The web also re-normalizes responses with `normalizeReceiptItems` and drops items without a name or price.

How the web calls this server, in `../bill-please/src/utils/receipt.util.ts`:

- It reads the URL from `VITE_APP_BILL_PLEASE_MCP_URL`, for example `http://localhost:3001`. There is no local mock fallback anymore.
- It resizes photos in the browser to a JPEG of at most 1600 px at quality 0.85 before upload. If the browser can't decode the photo, for example HEIC outside Safari, it sends the original file. So this server must keep accepting HEIC and HEIF.
- It polls `GET /api/receipts/status` with TanStack Query every 5 s while the tab is visible, and on window focus. It disables the "Add from bill" button when the request fails (server unavailable), or when `busy` is true. Then it shows the tooltip "AI กำลังทำงานอย่างหนัก โปรดรอสักครู่". CORS must therefore allow the web origin on that path too.
- The Axios timeout for a scan is 60 s.

## Environment (`.env.example`)

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3001` | |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated list. Add the LAN IP origin to test from a phone. `*` matches one part of a hostname, for example `https://bill-please-*-chatreejs-projects.vercel.app` for Vercel previews. |
| `MAX_IMAGE_BYTES` | 5 MB | |
| `RATE_LIMIT_PER_MINUTE` | `30` | |
| `TRUST_PROXY` | | `true` behind the Cloudflare tunnel and Traefik, to read `CF-Connecting-IP` and `X-Forwarded-For` |
| `OCR_URL`, `OCR_TIMEOUT_MS` | `http://localhost:8000`, `20000` | bill-please-ocr |
| `OCR_MIN_CONFIDENCE` | `0.6` | Mean line confidence below this answers 422 without an LLM call |
| `LLM_URL`, `LLM_MODEL`, `LLM_TIMEOUT_MS` | `http://localhost:8080/v1`, `qwen3-4b-instruct-2507`, `45000` | Any OpenAI compatible API |
| `LLM_API_KEY` | | Bearer token, only for APIs that need one |
| `LLM_MAX_CONCURRENT` | `1` | Scans sent to the LLM at the same time. The rest wait in a FIFO queue. Match the llm-server's llama.cpp `--parallel` |
| `LLM_QUEUE_MAX` | `1` | Scans allowed to wait for the LLM. More answer 503, and the web shows the busy tooltip. `0` rejects every scan while the LLM is busy. 1 fits the T400: a scan takes about 12 s (35 s for a big receipt), so a 2nd waiting scan often passes `LLM_QUEUE_TIMEOUT_MS` and a 3rd always does. Rule of thumb: queue timeout ÷ scan time + 1 |
| `LLM_QUEUE_TIMEOUT_MS` | `20000` | Longest wait for an LLM slot before 503. `0` waits until the client gives up. The web's 60 s Axios timeout covers OCR, the wait and the LLM call together |
| `LLM_REASONING_EFFORT` | `none` | Sent as `reasoning_effort`. `none` turns off reasoning in thinking models such as Gemma 4, which was 5 to 20 times slower with reasoning and no more accurate. Leave it empty for APIs that reject the field |
| `LLM_OUTPUT_FORMAT` | `gbnf` | `gbnf` sends `extractionGrammar`, a compact GBNF grammar that only llama.cpp accepts. On the T400 it cut the average output from 164 to 129 tokens. Set `json_schema` for any other OpenAI compatible API |
| `TURNSTILE_SECRET_KEY` | | Cloudflare Turnstile secret key. Empty turns the check off. For local tests use Cloudflare's test secrets `1x0000000000000000000000000000000AA` (passes) or `2x0000000000000000000000000000000AA` (fails) |
| `TURNSTILE_HOSTNAMES` | | Comma-separated hostnames a token must come from, for example `bill-please.chatree.dev`. Empty accepts any hostname on the widget |
| `TURNSTILE_TIMEOUT_MS` | `10000` | Timeout for the siteverify call |
| `LOG_LEVEL` | `INFO` | `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR` or `OFF` |

## Deployment

The app runs in the user's k3s cluster. The `Dockerfile` uses `oven/bun:1-alpine`, installs production dependencies only, runs as the non-root `bun` user and has a wget healthcheck. There is no docker-compose, because the user never runs Docker locally and Jenkins builds the images.

The Jenkins pipeline in `ci/Jenkinsfile` is copied from `../passwords`. Its stages run in this order:

1. Prepare Env reads the version from package.json. On `develop` it becomes `X.Y.Z-develop.<date>.<build>`.
2. Test runs check-types and the tests with lcov coverage in `oven/bun:1.4.3-alpine`. Keep that tag in sync with `.tool-versions`.
3. SonarQube scans with `sonar-project.properties`.
4. It builds the Docker image, scans it with Trivy and pushes `chatreejs/bill-please-mcp` to Docker Hub.
5. It triggers the gitops job `chatreejs/gitops/bill-please-backend-manifest-{dev,prod}` with the parameter `MCP_IMAGE_TAG`, then notifies Discord.

The manifest repo is `../../gitlab.com/chatreedev-manifest/bill-please-backend`. One Helm chart deploys this server and bill-please-ocr into the `bill-please-backend-{dev,prod}` namespaces, and the ocr pipeline sets `OCR_IMAGE_TAG` on the same gitops jobs. In the cluster, the mcp config points at the in-release OCR service and the shared llm-server.

- **Dev.** The Argo CD app `bill-please-backend-dev` (namespace `argocd`, the `applications.argoproj.io` resource) auto-syncs `main` of the manifest repo with prune and self-heal. A push to `develop` therefore reaches dev without a manual sync, once Jenkins has built the image and the gitops job has written the tag into `values-dev.yaml`. Dev serves `https://beta.mcp.chatree.dev/bill-please`; a Traefik middleware strips `/bill-please`, so `/health` is at `/bill-please/health`. Dev runs both services at `LOG_LEVEL=DEBUG`.
- **Prod.** `values-prod.yaml` is for `mcp.chatree.dev`, but there is no prod Argo CD app yet. Going live needs a merge to `main` in both code repos, the release Jenkins builds, a prod Argo CD app and `VITE_APP_BILL_PLEASE_MCP_URL=https://mcp.chatree.dev/bill-please` in the Vercel prod env of bill-please web.
- **Traffic path.** Cloudflare, then the cloudflared tunnel pod (namespace `cloudflare-tunnel`), then Traefik, then the pod. Traefik replaces `X-Forwarded-For` with the cloudflared pod IP, so with `TRUST_PROXY=true` (the chart default) the app reads `CF-Connecting-IP` first.
- **Replicas.** mcp runs 1 replica with no HPA in either environment, because each pod keeps its own in-memory rate limiter. Dev had an HPA override until 2026-10-30, and it could not read CPU or memory metrics.
- **Shutdown.** Both pods sleep 5 s in `preStop` (the Kubernetes `sleep` action, no binary needed), so Traefik stops routing to them before SIGTERM. mcp then lets in-flight scans finish within `terminationGracePeriodSeconds: 90`, which covers the OCR timeout, the LLM queue wait and the LLM timeout (20 s + 20 s + 45 s), and ocr within 30 s. Without the sleep, a rollout answered 504. With it, a restart under a request every 0.5 s returned 82 of 82 with 200.
- **LLM.** The cluster's llama.cpp accepts the `grammar` field and `reasoning_effort`, so dev keeps the `LLM_OUTPUT_FORMAT=gbnf` default. On the T400 a 14-item receipt (bill-3) takes about 42 s end to end, close to the web's 60 s Axios timeout.

CI is Jenkins only. SonarQube covers static analysis, so there is no GitHub Actions workflow and no CodeQL. Dependabot updates the Bun dependencies and the Docker base image.

## Status and roadmap

Done: REST and MCP endpoints, the OCR and LLM scanner, the zod contract, CORS, rate limiting, Turnstile on the REST scan, JSON logging with request ids, graceful SIGTERM shutdown, the LLM queue, the status endpoint, tests (63 passing), the Dockerfile and the web integration.

Likely next steps:

1. Code work happens on `develop`, with `git@github.com:chatreejs/bill-please-mcp` as the remote. Add commitlint and husky like bill-please, for Conventional Commits with a lowercase subject.
2. Finish the scanner: test it on real receipts, a `/livez` probe and a dependency-aware `/health`, and maybe a cloud fallback. The user hasn't chosen a cloud provider.
3. Add auth on `/mcp`, an API key or OAuth, before exposing a paid model publicly.
4. Use a shared rate-limit store if the server runs as several replicas.
5. A possible future MCP tool could create a bill-please bill from the items and return a link that opens the web app pre-filled. That needs an import-from-URL feature in bill-please web, which only uses localStorage today.
6. Add lint and format tooling. bill-please uses eslint and prettier, with single quotes and trailing commas.

## Related repos

- [bill-please-ocr](../bill-please-ocr) is the OCR step of the scanner. It is a Python service with FastAPI and PaddleOCR, and `POST /v1/ocr` returns receipt text lines. The user decided to keep OCR in Python and keep this Elysia server as the API, which will call the OCR service over HTTP. The design and roadmap are in the local `docs/` folder, which is gitignored and not pushed.
- The shared on-prem LLM is the `llm-server` Helm chart in `../../gitlab.com/chatreedev-manifest/llm-server`, at `http://llm-server.llm-server.svc:8080/v1`. Its NetworkPolicy admits pods labelled `app: bill-please-mcp` from the `bill-please-backend-{dev,prod}` namespaces, so the manifest keeps that label on the mcp pods.

To test the scanner locally, run bill-please-ocr with `PORT=8000 uv run python -m receipt_ocr` in its repo, port-forward the LLM with `kubectl -n llm-server port-forward svc/llm-server 8080:8080`, and start this server with `bun dev`. The defaults of `OCR_URL` and `LLM_URL` point at those ports.
