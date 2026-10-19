# Selection question answering implementation plan

**Goal:** Implement phase one of the approved [proposal](../../proposals/2026-10-18/02-selection-question-answering.md): local paper evidence, selection questions, streamed answers, verified citations and local conversations.

**Architecture:** Main-process services own document resolution, evidence, provider credentials, request lifecycle and persistence. A background worker extracts PDF text and geometry; the renderer owns the question panel's batched stream state. Translation and questions share provider admission and HTTP transport, while retaining separate prompts, caches and usage.

**Tech stack:** Existing Electron, React, TypeScript, PDF.js, Vitest and Playwright. No new runtime dependencies.

**Constraints:** Only explicitly sending calls the configured provider. Never infer bilingual correspondence from page numbers. No web search, OCR uploads or model tools. Unknown citation IDs cannot produce links. Selection limit is 2,000 characters; excess is rejected, never silently truncated. Each conversation permits one active request. No automatic paid retries. Preserve reader typography, colors and reading anchors; no width animation.

- [x] Evidence and validation: add shared question contracts; resolve versions only through open library records; extract physical pages and normalized geometry in a worker; cache indexes by content hash; retrieve selected/neighboring paragraphs and local keyword matches within a conservative token upper bound. Verify with generated PDF fixtures, double columns, cross-page definitions, invalid anchors and scanned pages.
- [x] Provider transport: extract authenticated HTTP and usage measurement; add shared per-service QPS/concurrency admission with bounded question priority and abort support. Keep translation schemas and cache behavior intact. Verify SSE chunk boundaries, UTF-8, cancellation, malformed responses, usage and scheduling fairness with local servers.
- [x] Question service: bind immutable selections, evidence and document versions to conversations; send separate system instructions and quoted data; validate citations; persist completed/partial/error turns; scope result reuse by evidence, question, provider, model, rules and conversation. Verify isolation, duplicate sends, unknown citations, local-only insufficient evidence and restart history.
- [x] Reader UI and IPC: add selection action and keyboard entry; use one auxiliary area for questions or notes; support quick prompts, follow-up, stop, explicit retry, history/delete, copy, save-as-new-note and citation navigation. Explain fragment transmission on first send. Batch deltas in the panel every 40 ms. Verify no request on selection/open, Escape focus restoration and wide/narrow layouts.
- [x] Acceptance: run targeted tests then the full test suite and build; run Electron smoke checks for question flows, stale event isolation and reading scroll behavior; inspect screenshots; obtain an independent code review and resolve material findings. Record automated evidence separately from human answer-quality targets.

Execution is inline in the current workspace, as authorized by the implementation request. This directory has no Git metadata, so verification uses tests and generated artifacts rather than commit comparisons.

Verification record: [phase-one validation](../../proposals/2026-10-18/02-selection-question-answering-validation.md). Automated implementation/acceptance is complete; the optional real-paper human quality targets remain explicitly unmeasured.
