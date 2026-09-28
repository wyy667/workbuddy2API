# Bundled HTTP dispatcher

Undici 7.30.0, MIT. Source: https://github.com/nodejs/undici/tree/v7.30.0

Rebuild from this directory using `npm ci && npm run build`; audit using `npm audit --omit=dev`. package-lock.json pins the source and build tool. Runtime deployment needs only backend/http-dispatcher.cjs and the license; no server-side npm installation is required.

Each origin has at most 32 connections (HTTP/1 pipelining 1). Application admission separately caps model requests at 128 by default. These are per-origin and model-request limits, not a global cap on every background network call. Parser deadlines are delegated to application AbortSignal/readWithIdle timers. Native fetch is retained.

Audit performed 2026-09-27: npm audit --omit=dev reported no known vulnerabilities for the pinned Undici package. This is a point-in-time check, not a guarantee against future advisories.
