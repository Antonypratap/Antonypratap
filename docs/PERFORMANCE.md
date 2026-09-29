# Veyra performance

Phase 7 measured Veyra first, changed only what the measurements pointed at, and measured again
with the same harness. This page covers the method, the numbers before and after, what changed and
why, and what is still slow. Every number here comes from `apps/api/bench/results/*.json` and can
be reproduced with the commands in §2.

**Summary**

- The inbox and the open-questions list were the slow endpoints. Both had N+1 query patterns.
  With 200 invoices the inbox went from 159 ms to 22 ms p50, and from 1.7 s to 0.19 s p50 with
  10 clients loading it at once.
- A digital PDF goes from upload to settled in 52 ms p50 (was 73 ms). The first invoice after a
  restart no longer pays about 1 s for loading the document readers.
- Photos and scans are dominated by Tesseract OCR: about 1 s per page of CPU. That is unchanged
  by design (§11).
- In the browser, every screen made 2–4 duplicate requests, and an idle inbox polled 60 times a
  minute. Duplicates are gone, idle polling is reduced, and the first page downloads less
  JavaScript (§9).
- Nothing about business behaviour, idempotency, audit order or transaction boundaries changed.
  The equivalence tests in §6 prove the responses are identical.

## 1. Environment

| | |
|---|---|
| CPU | 4 vCPU, Intel Xeon 2.1 GHz (shared cloud container) |
| Memory | 16 GB |
| Node.js | 22.22.2 |
| PostgreSQL | 16.13 on the same host, default configuration (`shared_buffers` 128 MB, `work_mem` 4 MB, `max_connections` 100, `synchronous_commit` on) |
| Veyra pool | node-postgres, `VEYRA_DB_POOL_MAX` 10 (default) |
| ERP | the fake ERP (SQLite, WAL, on the same disk) |
| Network | none: the harness calls the API in-process (`fastify.inject`), so API numbers exclude TCP and TLS |

These are not production numbers. A managed PostgreSQL over the network adds about 0.5–2 ms per
query, and a real ERP adds its own latency (reported separately as ERP_LOOKUP / ERP_WRITE, §4).
They are, however, **comparable with each other**: the same machine, the same data, and the same
harness ran before and after every change. Timings on a shared container vary about ±25% between
runs; differences smaller than that are treated as noise.

## 2. How to run it

```sh
export TEST_DATABASE_URL=postgres://…         # a disposable database; each run creates its own
cd apps/api
npm run bench -- <label> [db,api,erp,flows,answer,reprocess,ocr]
npm run bench:load -- <label>                  # 1 and 3 workers, concurrency, invariants
npx tsx bench/compare.ts baseline <label>      # before/after, every metric side by side
npx tsx bench/explain.ts 1000                  # EXPLAIN ANALYZE at ~19,000 invoices
node ../../scripts/bench-browser.mjs <label>   # browser: requests per screen, idle polling, bundle
```

- **Documents are realistic.** The flows upload the Chromium-rendered samples D01–D12 (text PDFs,
  scans, phone photos, a blurry photo, two invoices in one file), each with a fresh invoice number,
  through the real local extractor (pdf.js and Tesseract). The fixture extractor is not used.
- **Every metric is reported separately** as p50 / p95 / p99, min, max, mean, count and error
  count, for: database queries, API endpoints, each ERP connector operation, extraction, OCR, the
  job queue (wait and execution), the whole workflow, and the browser.
- **The baseline was measured on the unmodified code** (commit `adad549`) in a separate git
  worktree, with the same harness files, before any change here.

## 3. Instrumentation added

Each job and each upload or answer request now logs **one** line with a stage summary:

```
{"msg":"job finished","jobId":"…","invoiceId":"…","queueWaitMs":4,"durationMs":41,
 "stages":{"EXTRACTION":{"ms":19.3,"n":1},"VALIDATION":{"ms":0.8,"n":1},"MATCHING":{"ms":0.1,"n":1},
           "ERP_LOOKUP":{"ms":1.5,"n":6},"PERSIST":{"ms":11,"n":1},"AUDIT":{"ms":4,"n":3}}}
```

- Stages: UPLOAD, EXTRACTION, OCR, VALIDATION, MATCHING, ERP_LOOKUP, ERP_WRITE, PERSIST,
  QUESTION, COMMIT, AUDIT (`apps/api/src/perf/timing.ts`).
- They are **exclusive**, so they add up. MATCHING does not include the ERP reads it makes (those
  are ERP_LOOKUP), and EXTRACTION does not include OCR.
- The request id, job id, invoice id, duration and outcome come with every line. The lines carry
  only stage names, milliseconds and counts, **never document contents**. The redaction rules of
  SECURITY.md §10 still apply; the rule for OCR output was narrowed to `ocr_text`, `ocr_lines`, …
  so that the stage name `OCR` itself is not redacted.
- ERP operations are timed by a wrapper around the connector (`timedErp`). The connector contract
  and its behaviour are unchanged: same arguments, same results, same errors.
- `/health/ready` reports the database pool: open, idle, waiting, max.
- Overhead: one `AsyncLocalStorage` scope per job and one `performance.now()` pair per stage.
  That is below the measurement noise.

## 4. Where the time goes (per invoice, after)

**Digital PDF, upload → settled: 52 ms p50** (40 invoices, realistic mix; `after.json`):

| Stage | p50 ms | What it is |
|---|---|---|
| Upload request | 7 | multipart parse, hash, write file, insert rows, enqueue |
| Queue wait | 4 | until a worker claims the job (poll interval) |
| EXTRACTION | 19 | pdf.js text, parsing, field evidence (the whole extractor: 11 ms) |
| PERSIST | 11 | writing fields, lines, match and validation results |
| AUDIT | 4 | 3 audit events |
| ERP_LOOKUP | 1.5 | about 6 connector reads (fake ERP: 0.1–0.9 ms each) |
| VALIDATION | 0.8 | GST, totals, arithmetic |
| MATCHING | 0.1 | 3-way match itself |
| COMMIT + ERP_WRITE | 10.5 + 2.3 | only invoices that auto-post (then in one transaction) |

**Photo or scan: 1.15 s p50.** OCR (Tesseract) 0.97 s, image preparation 0.13 s, the rest as
above.

**Veyra time versus ERP time versus OCR time:** for a digital invoice, Veyra's own processing is
about 45 ms, the fake ERP 1.5–4 ms, and OCR 0. For a photo: Veyra about 45 ms, ERP about 1 ms, and
OCR about 1 s. With a real ERP over a network, ERP_LOOKUP will grow by the ERP's round-trip time
multiplied by the number of reads (about 6); the logs show it separately.

## 5. Before and after

p50 (p95), milliseconds; lower is better. "200 invoices" is a database seeded through the real
workflow with every demo scenario repeated.

| Measurement | Before | After | Change |
|---|---|---|---|
| `GET /invoices` (inbox), 40 invoices | 34 (47) | 11 (19) | −68% |
| `GET /invoices` (inbox), 200 invoices | 159 (206) | 22 (41); 33 in a later run | −79 to −86% |
| inbox, 10 concurrent clients, 200 invoices | 1716 (2525) | 194 (254) | −89% |
| `GET /questions` (open), 200 invoices | 102 (145) | 20 (27); 34 in a later run | −67 to −80% |
| `GET /invoices/:id` (detail), 200 invoices | 10.2 (13.9) | 10.7 (16.1) | noise |
| digital PDF, upload → settled | 73 (97) | 52 (65) | −29% |
| digital PDF, pipeline execution | 57 (78) | 40 (48) | −30% |
| photo, upload → settled | 1274 (1978) | 1150 (1436) | −10% |
| OCR PNG preparation (per image) | 74 | 5–7 | −92% |
| OCR engine start (first photo) | 1606 | 1414 | at startup now (§7) |
| first text PDF after a restart | ≈ 1000 | 63–71 | −93% |
| answer → settled (incl. ERP commit) | 62 (74) | 52 (78) | noise |
| reprocess → settled | 22 (39) | 19 (31) | noise |

Small endpoints (1–8 ms: session, ERP lists, audit by invoice, health) moved by ±1–3 ms in both
directions between runs. That is within the noise of a shared container, plus about 1 ms of
compression CPU for responses above 1 KB (which saves far more on a real network, §9). Database
primitives (a pool round trip at 0.07–0.1 ms, a session resolve at 0.55 ms) are unchanged.

## 6. Database

### N+1 patterns removed

- **Inbox** (`present.ts summaries`): for every invoice it made separate queries for the latest
  document, the fields, the open questions and a PO lookup in the ERP. Now it runs one query each
  for fields (only the 9 fields the list shows), questions and documents across all invoices,
  plus one ERP read per **distinct** PO.
- **Open questions** (`present.ts questions`): the same fields are loaded in one query for all
  questions.
- **Extraction** (`veyra.ts`): extracted fields were written one row at a time (an upsert per
  field, about 30 per invoice). Now one multi-row upsert writes them all; conflict rules are
  unchanged, and a value a human already entered is never overwritten. Invoice lines, match
  results and validation results likewise go in one statement each, inside the same transaction
  as before.

**Proof that nothing changed:**

- `http/present.test.ts` builds every demo scenario plus an answered, a rejected, a failed and a
  queued invoice. It asserts that the batched inbox equals, field for field, the per-invoice
  `summary()` the detail view still uses, and that every open question equals its per-question
  reading.
- `workflow.test.ts` asserts that re-extraction keeps human-entered values, field ids, sequence
  numbers and order, and rewrites the other fields with the new extraction id.
- The whole existing suite (workflow, idempotency, concurrency, audit order) passes unchanged.

### Indexes (migration `0002_perf_indexes`)

Measured with `bench/explain.ts 1000`: every scenario replicated to about 19,000 invoices and
half a million audit events, then `ANALYZE`, then `EXPLAIN ANALYZE`.

| Index | Query it serves | Before | After | Cost |
|---|---|---|---|---|
| `questions_invoice (invoice_id, seq)` | questions of an invoice (detail, inbox batch) | 3.5 ms, seq scan | 0.022 ms | ≈ 1 MB; one more index write per question |
| `questions_open (seq) WHERE status = 'open'` | the open-questions list | 79 ms, seq scan + sort | 6.3 ms | smaller than 1 MB (only open questions); written only while open |
| `extractions_invoice (invoice_id, created_at)` | latest extraction of an invoice | 7.2 ms | 0.029 ms | ≈ 1 MB; one write per extraction |
| `jobs_invoice (invoice_id, created_at)` | jobs of an invoice (detail, reprocess checks) | 1.7 ms | 0.03 ms | ≈ 1 MB; one write per job |

The batched questions query for a 200-invoice inbox went from 5.2 ms to 0.82 ms. Write overhead
is one B-tree insert per row on tables written a few times per invoice: not measurable in the
flows above. The migration builds the indexes with plain `CREATE INDEX` (a short write lock,
DEPLOYMENT.md §4).

**Not indexed, deliberately:**

- `security_events` newest-first: it is read only by an ADMIN, rarely.
- Audit by invoice: it already uses the existing `audit_events_invoice` index.

### Connection pool

The pool was **not changed** (default max 10). Evidence:

- With 1 worker and 30 concurrent uploads, up to 11–13 requests waited for a connection at the
  peak. But the API process was at 88–100% of one CPU at the same time, and the database was
  mostly idle.
- The limit is the single Node.js event loop (parsing PDFs, encoding responses), not
  connections. A bigger pool would only queue the same work inside PostgreSQL.
- With 3 workers there are three pools (up to 30 connections) against the default 100.

The pool counts are now in `/health/ready`, so a real deployment can collect the same evidence
before changing `VEYRA_DB_POOL_MAX` (DEPLOYMENT.md §6).

### Caching

**None added.** Every database read the product makes is under 1 ms p95 at today's sizes, and
the inbox costs are now query count, not query time. A cache would add staleness to the numbers
that finance users act on, for no measurable gain. No Redis.

## 7. Workflow and extraction

- **Warm-up at startup:** pdf.js loads, the Tesseract engine starts, and a tiny generated PDF is
  read once before the process listens. This costs about 1.2 s at startup and saves the first
  invoice about 1 s (digital) or about 0.4 s (photo). A failed warm-up is logged and startup
  continues.
- **OCR image preparation:** the greyscale image was encoded to PNG with adaptive filters; it is
  now written unfiltered. That took 74 ms before and 5–7 ms after, and the pixels are identical
  (tested), so OCR reads exactly the same image.
- **Parallelism:** the independent reads in a job are already few and fast (six ERP reads of
  0.1–0.9 ms each). Running them concurrently would save less than a millisecond with the fake
  ERP while complicating error handling, so they stay sequential. Workflow steps that depend on
  each other (extract → validate → match → question/commit) stay in order. Audit writes stay
  inside their transactions and in the same order.
- The job runner, leases, retries and idempotency keys are unchanged.

## 8. Load and concurrency

`npm run bench:load` runs each scenario twice: with 1 worker (the API process alone), and with
3 workers (the API process plus two more Veyra processes on the same database, documents and
ERP). Before each measured scenario, every process reads one warm-up document. Each side ran
**5 times, alternating** before and after on the same machine (`load-baseline*.json`,
`load-after*.json`). The table shows the **median of the 5 runs** and, in brackets, the range.

| Scenario (p50 unless noted), ms | 1 worker, before | 1 worker, after | 3 workers, before | 3 workers, after |
|---|---|---|---|---|
| 30 concurrent digital uploads: upload request | 280 [255–315] | 254 [243–296] | 210 [183–232] | 217 [193–306] |
| … upload → settled | 1977 [1829–2115] | 1426 [1324–1564] | 1404 [1095–2075] | 1167 [1018–1179] |
| … upload → settled, p95 | 3235 [3058–3516] | 2355 [2168–2560] | 2132 [1653–3530] | 1766 [1575–1809] |
| … invoices per minute | 552 [506–582] | 754 [695–822] | 832 [499–1075] | 995 [929–1067] |
| 6 concurrent photos (OCR): upload → settled | 4246 [3933–4472] | 4177 [3802–4521] | 3192 [2037–3395] | 2441 [1945–2888] |
| … all 6 settled | 8306 [8229–8443] | 8129 [7931–8393] | 4545 [3404–4799] | 3987 [3291–4193] |
| 10 concurrent answers: answer request | 101 [93–159] | 107 [99–121] | 110 [91–122] | 109 [89–138] |
| 10 inbox clients × 20 loads during processing | 138 [129–148] | 68 [60–79] | 204 [182–218] | 81 [74–106] |
| … inbox p95 | 184 [161–214] | 104 [88–119] | 271 [268–344] | 137 [116–179] |

**What this shows:**

- **Digital throughput with one process is up about 35%** (552 → 754 invoices per minute), and
  the time from upload to settled is down by about a quarter. The cause is less database work
  per invoice (the batched writes, §6).
- **The inbox stays fast while documents are processed:** about 2× faster at p50 and p95, with
  1 or 3 workers.
- **Photos are bound by OCR CPU.** One process reads about 44 photos per minute before and
  after. Three processes read about 80–90 per minute on this 4-core machine; more workers need
  more cores.
- **Answer and upload request times are unchanged.** They are dominated by the same event loop
  that is busy reading documents (§11.2). A single run earlier suggested answers got slower; the
  5-run medians overlap completely, so it was noise.
- **3 workers vary a lot run to run** (which process claims which job). The "before" range is
  wide (499–1075 invoices per minute). "After" is both faster at the median and more consistent.

**Correctness under load.** After every scenario the harness checks the invariants:

- every invoice settled;
- no job left queued or running;
- no duplicate ERP purchase invoice, and at most one ERP invoice write per invoice;
- every ERP write confirmed.

In the double-answer race, the same question is answered twice at once. The result was always
exactly one `200` and one `409`.

- **All 40 "after" scenario runs had no problems.**
- One early "before" run with 3 workers ended with 2 ERP writes in state `failed`. There was no
  duplicate record, and the invoices were left waiting for a person. It did not happen again in
  the 4 later full "before" runs, in a targeted repeat of that scenario on the "before" code, or
  in 5 targeted repeats on the "after" code. The harness now records the operation and
  error code of any unconfirmed write, so a recurrence can be diagnosed (§11).

**Connection pool:** the "after" code reports pool waits (the baseline code could not). With
1 worker and 30 concurrent uploads, 3–13 requests waited for a connection at the peak. With
3 workers there were 0–5. Why the pool size was left alone is in §6.

## 9. Browser

`scripts/bench-browser.mjs` drives Chromium against the production build (`vite preview`, the
same security headers as production), signed in as a test-only FINANCE user, with 60 realistic
invoices. The before and after builds were served alternately on the same port, against the same
API and data, 3 times each (`browser-baseline.json`, `browser-after*.json`).

| | Before | After |
|---|---|---|
| JavaScript + CSS on the first page | 519 KB (one 430 KB script) | 402 KB. The product screens (68 KB) and sign-in (3 KB) are separate chunks, loaded only when opened |
| API requests: inbox / invoices / questions | 6, of which 2 duplicates | 4, no duplicates |
| API requests: invoice detail | 8 (3 duplicates) | 5 (0) |
| API requests: audit | 9 (3 duplicates) | 6 (0) |
| API requests: ERP vendors | 10 (4 duplicates) | 6 (0) |
| Idle inbox, requests per minute | 60 | 30 |
| Idle invoice detail, requests per 20 s | 25 (the invoice itself every 4 s) | 10 (the invoice only when something changed) |
| Time to content: invoice detail | 150–178 ms | 101–138 ms |
| Time to content: homepage, other screens | 330–400 ms; 20–110 ms | the same (within noise) |

**What changed in the web app:**

- **No duplicate requests.** A screen used to load its data, and then a refresh right after
  loading it again. Now the first load does not count as a change.
- **Health and demo scenarios are loaded once** per page (they do not change while it is open),
  not on every poll.
- **Polling pauses while the tab is hidden** and resumes, with one refresh, when the tab comes
  back.
- **The open invoice is re-read only when the inbox shows it changed,** instead of every
  4 seconds.
- **The product and sign-in screens are code-split** (`React.lazy`). The public page no longer
  downloads the product.
- **JSON responses above 1 KB are compressed** (brotli or gzip). With 200 invoices, the inbox
  shrinks from 122 KB to 13 KB, the open questions from 289 KB to 11 KB, and the audit list from
  255 KB to 28 KB. This costs 0.3–1.8 ms of CPU per response (`after-api.json`). PDFs, images and
  uploads are never compressed (§12).

Localhost has no bandwidth limit, so the smaller downloads do not show in the homepage time here.
On a mobile connection, 117 KB less JavaScript and about 90% smaller lists matter far more.

## 10. Memory and CPU

Peak resident memory (RSS) and CPU, medians of the 5 load runs:

| | Before | After |
|---|---|---|
| API process, 30 digital uploads, 1 worker | 599 MB RSS, heap 206 MB, 100% of one core | 589 MB, heap 203 MB, 107% |
| API process, 6 photos, 1 worker | 751 MB RSS, 114% | 739 MB, 124% |
| API process, 3 workers (digital) | 584 MB | 553 MB |
| each extra worker process | 365–600 MB | 340–600 MB |
| database connections at peak (30 digital uploads) | 10 (1 worker), 14 (3 workers) | the same |

- About 350 MB of each process is the loaded document readers: pdf.js and the Tesseract WASM
  engine with its language data. OCR adds about 150 MB while it runs.
- A process should get **at least 1 GB of memory**, and a single-core host will be CPU-bound on
  photos.
- CPU above 100% is Tesseract's and zlib's work on other threads.
- Memory and CPU did not change materially with this phase. The slightly higher CPU share
  "after" is the same work done in less wall time.

## 11. Remaining bottlenecks

In order of expected impact:

1. **OCR is CPU-bound:** about 1 s per page on one core. Three workers process three photos at
   once; more need more cores. A faster OCR engine or a paid service is out of scope (no document
   leaves the server).
2. **pdf.js and image decoding run on the API's main thread,** so while a large document is being
   read in a process, other requests on that process wait (the load test shows upload requests
   slowing while documents are read, §8). Every Veyra process also runs the job loop, so more
   processes spread the reading but do not remove the wait. Moving extraction to a worker thread
   would fix it properly.
3. **The inbox is not paginated.** It is fast at 200 invoices (22 ms) and will grow linearly;
   pagination is needed at a few thousand open invoices.
4. **The detail view reads all purchase invoices from the ERP** (`listPurchaseInvoices`) to find
   one. That is fine with the fake ERP; a real connector needs `getPurchaseInvoice(id)` (with the
   iBEAM integration).
5. **Rate limits are per process.** With several API processes, the effective limit is multiplied.
6. **Migrations build indexes with plain `CREATE INDEX`,** which briefly blocks writes. For very
   large tables this should become `CONCURRENTLY` (outside a transaction).
7. **Compression CPU:** it costs 0.3–1.8 ms per list response on this machine and saves 70–96% of
   the bytes. Behind a proxy that compresses, it could be turned off in Veyra.
8. **The open-questions list returns every question's full input schema** (289 KB uncompressed
   at 200 invoices). Compression hides most of it; a lighter list shape would fix it.
9. **Unexplained once:** 2 ERP writes ended `failed` in one early 3-worker "before" run (§8).
   They were not reproduced in 11 later runs. The harness now records the operation and error
   code if it happens again.

## 12. What was deliberately not done

- No Redis, Kafka, Kubernetes or microservices. No new cache layer (§6).
- No change to business rules, matching, state transitions, idempotency, audit ordering or
  transaction boundaries.
- No lower OCR quality (same engine, same settings, same pixels).
- No security change: every endpoint keeps its access rule, CSRF, headers and rate limits.
  Compression is excluded from sign-in responses, which carry the CSRF token (SECURITY.md §8),
  and never applies to documents, images, spreadsheets or uploads.
