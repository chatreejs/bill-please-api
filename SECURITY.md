# Security Policy

## Introduction

This document outlines the security policy for Bill Please API, the receipt scanning backend for the [Bill Please](https://bill-please.chatree.dev/) open source project. The policy is intended to provide guidelines and procedures for reporting, triaging, and addressing security vulnerabilities in the project.

## Scope

The security policy covers the codebase, Docker image and documentation of this repository, including:

- The REST endpoints (`POST /api/receipts/scan`, `GET /api/receipts/status`, `GET /livez`, `GET /health`, `GET /readyz`).
- Handling of uploaded receipt images (validation, size limits, forwarding to scanner providers).
- Rate limiting, CORS and proxy (`X-Forwarded-For`) handling.

Vulnerabilities in the Bill Please web app should be reported according to the [Bill Please security policy](https://github.com/chatreejs/bill-please/blob/main/SECURITY.md). Vulnerabilities in third-party dependencies (Bun, Elysia, AI providers) should be reported to their maintainers; let us know too if this project is affected.

## Supported Versions

Only the latest release on the `main` branch receives security fixes.

## Vulnerability Disclosure Process

**Please do not report security vulnerabilities through public GitHub issues, discussions or pull requests.**

Send vulnerability reports to the dedicated email address **contact@chatree.dev**, or use GitHub's [private vulnerability reporting](https://github.com/chatreejs/bill-please-api/security/advisories/new) if it is enabled. Please include:

- A description of the issue and its impact.
- Steps to reproduce (requests, payloads, configuration) or a proof of concept.
- The affected version or commit.

Vulnerability reports will be reviewed and triaged by the project's maintainers. The owner will aim to respond to vulnerability reports within 72 hours and will provide regular updates on the status of the vulnerability and any remediation efforts.

## Roles and Responsibilities

The maintainers are responsible for handling vulnerability reports and making decisions about how to address them. They will also work with contributors and reporters to resolve the issue(s) as quickly as possible.

## Response Timeline

Bill Please API will aim to resolve critical vulnerabilities within 30 days and non-critical vulnerabilities within 90 days. These deadlines may extend if additional time is needed to address the issue(s).

## Secure Deployment Notes

If you host your own instance:

- `POST /api/receipts/scan` relies on Cloudflare Turnstile and the rate limit. Set `TURNSTILE_SECRET_KEY` before you expose it publicly with a paid AI model.
- Set `TRUST_PROXY=true` only when running behind a reverse proxy you control; otherwise clients can spoof `X-Forwarded-For` to bypass rate limiting.
- Restrict `CORS_ORIGINS` to the web app origins you actually serve.
- Keep provider API keys in `.env` (never commit it) or your secret manager.
- Rate limiting is in-memory per process; use a shared store when running multiple replicas.

## Secure Coding Practices

Contributors should validate all input (MIME type, size, schema), always validate scanner output through the shared zod contract, never log receipt images or secrets, and keep dependencies up to date.

## Regular Review and Update

The security policy will be regularly reviewed and updated to ensure that it remains effective and relevant. The maintainers will evaluate the vulnerability disclosure process, update secure coding guidelines, and revise the response timeline as needed.

## Disclosure Policy

Bill Please API will follow a coordinated disclosure policy, which means that vulnerabilities will be disclosed publicly only after they have been remediated. Reporters will be credited unless they prefer to remain anonymous.

## Legal Disclaimer

The software is provided "as is", without warranty of any kind, as described in the [AGPL-3.0 License](./LICENSE). The project maintainers and contributors are not liable for any security vulnerabilities or incidents that occur as a result of using or self-hosting Bill Please API.

## Contact Information

If you have any questions or concerns about the security policy or any security vulnerabilities in the project, please contact us at _contact@chatree.dev_.

By implementing this security policy, we aim to ensure that vulnerabilities are addressed promptly and that users and contributors can use Bill Please API and its linked sources safely and securely.
