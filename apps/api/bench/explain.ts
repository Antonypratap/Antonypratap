/**
 * Query plans at scale (Phase 7, docs/PERFORMANCE.md "Database").
 *
 *   TEST_DATABASE_URL=postgres://… npx tsx bench/explain.ts [multiplier]
 *
 * Seeds every demo scenario through the real workflow (a realistic mix of rows in every table),
 * then replicates those rows `multiplier` times in SQL with fresh ids (default 1000: about 19,000
 * invoices and half a million audit events), ANALYZEs, and prints EXPLAIN ANALYZE for the queries
 * the product runs most. Nothing here changes the schema permanently.
 */
import pg from 'pg';
import { SCENARIOS } from '@veyra/extractor';
import { createHarness } from '../src/test/harness';

const multiplier = Number(process.argv[2] ?? 1000);
const h = await createHarness();
for (const s of SCENARIOS) await h.upload(s.id);
const client = new pg.Client({ connectionString: h.database.url });
await client.connect();
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  v: unknown[] = [],
) => (await client.query<T>(text, v)).rows;

/** Tables in FK order; how each column is rewritten for a copy (k = copy number). */
const TABLES = [
  'documents',
  'invoices',
  'extractions',
  'extracted_fields',
  'invoice_lines',
  'match_results',
  'creation_actions',
  'validation_results',
  'questions',
  'erp_writes',
  'audit_events',
  'jobs',
];
const KEEP = new Set([
  'actor_user_id',
  'answered_by_user_id',
  'uploaded_by_user_id',
  'confirmed_by_user_id',
  'user_id',
]);
const t0 = performance.now();
for (const table of TABLES) {
  const cols = (
    await q<{ column_name: string; is_identity: string }>(
      `select column_name, is_identity from information_schema.columns where table_name = $1 and table_schema = 'public' order by ordinal_position`,
      [table],
    )
  ).filter((c) => c.is_identity !== 'YES');
  const expr = (c: string) =>
    c === 'id' || (c.endsWith('_id') && !KEEP.has(c) && !c.endsWith('user_id') && c !== 'erp_id')
      ? `case when ${c} is null then null else ${c} || '-' || k end`
      : c === 'sha256'
        ? `encode(sha256(convert_to(sha256 || k, 'UTF8')), 'hex')`
        : c === 'idempotency_key' || c === 'dup_invoice_no'
          ? `case when ${c} is null then null else ${c} || '-' || k end`
          : c;
  const names = cols.map((c) => c.column_name);
  await client.query(
    `insert into "${table}" (${names.map((n) => `"${n}"`).join(', ')})
     select ${names.map((n) => `${expr(n)}`).join(', ')}
     from "${table}", generate_series(1, ${multiplier}) as k`,
  );
}
await client.query('analyze');
const counts = await q<{ t: string; n: string }>(
  TABLES.map((t) => `select '${t}' as t, count(*)::text as n from "${t}"`).join(' union all '),
);
console.log(
  `replicated ×${multiplier} in ${Math.round((performance.now() - t0) / 1000)} s:`,
  Object.fromEntries(counts.map((r) => [r.t, Number(r.n)])),
);

const inv =
  (await q<{ id: string }>(`select id from invoices order by seq desc limit 1`))[0]?.id ?? '';
const invIds = (await q<{ id: string }>(`select id from invoices order by random() limit 200`)).map(
  (r) => r.id,
);

const QUERIES: [string, string, unknown[]][] = [
  [
    'questions of one invoice (detail, summary, answers)',
    `select * from questions where invoice_id = $1 order by seq`,
    [inv],
  ],
  [
    'open questions (Questions screen)',
    `select * from questions where status = 'open' order by seq`,
    [],
  ],
  [
    'questions of 200 invoices (inbox, batched)',
    `select * from questions where invoice_id = any($1) order by seq`,
    [invIds],
  ],
  [
    'list fields of 200 invoices (inbox, batched)',
    `select * from extracted_fields where invoice_id = any($1) and path = any($2)`,
    [
      invIds,
      ['header.invoiceNumber', 'header.vendorName', 'header.invoiceDate', 'header.totalPaise'],
    ],
  ],
  [
    'fields of one invoice (engine, detail)',
    `select * from extracted_fields where invoice_id = $1 order by path collate "C"`,
    [inv],
  ],
  [
    'latest extraction of one invoice (detail)',
    `select * from extractions where invoice_id = $1 order by created_at desc, seq desc limit 1`,
    [inv],
  ],
  [
    'jobs of one invoice (detail)',
    `select * from jobs where invoice_id = $1 order by created_at desc, seq desc`,
    [inv],
  ],
  [
    'claim the next job',
    `select * from jobs where status = 'queued' and run_after <= now() and invoice_id not in (select invoice_id from jobs where status = 'running') order by run_after, seq limit 1`,
    [],
  ],
  [
    'audit trail of one invoice',
    `select * from audit_events where invoice_id = $1 order by seq`,
    [inv],
  ],
  [
    'committed creations of one invoice (inbox note)',
    `select entity from creation_actions where invoice_id = $1 and status = 'committed' order by seq`,
    [inv],
  ],
  [
    'invoice lines of one invoice',
    `select * from invoice_lines where invoice_id = $1 order by line_no`,
    [inv],
  ],
  [
    'security events, newest 200 (ADMIN)',
    `select * from security_events order by seq desc limit 200`,
    [],
  ],
];

/** Candidate indexes (docs/PERFORMANCE.md): each is tried and the same plans printed again. */
const CANDIDATES = [
  'create index questions_invoice on questions (invoice_id, seq)',
  "create index questions_open on questions (seq) where status = 'open'",
  'create index extractions_invoice on extractions (invoice_id, created_at)',
  'create index jobs_invoice on jobs (invoice_id, created_at)',
];

async function plans(title: string) {
  console.log(`\n=== ${title} ===`);
  for (const [name, sql, values] of QUERIES) {
    const plan = await q<{ 'QUERY PLAN': string }>(
      `explain (analyze, buffers, costs off, summary on) ${sql}`,
      values,
    );
    const lines = plan.map((r) => r['QUERY PLAN']);
    const scan = lines
      .filter((l) => /Scan on|Scan using/.test(l))
      .map((l) => l.trim().replace(/\s+\(actual.*$/, ''))
      .slice(0, 3)
      .join(' | ');
    const exec = lines.find((l) => l.startsWith('Execution Time'));
    console.log(`\n${name}\n  ${scan}\n  ${exec}`);
    if (process.env.VERBOSE) console.log(lines.map((l) => `    ${l}`).join('\n'));
  }
}

await plans('current schema');
if (!process.env.NO_CANDIDATES) {
  for (const c of CANDIDATES) await client.query(c);
  await client.query('analyze');
  const sizes = await q<{ name: string; size: string }>(
    `select c.relname as name, pg_size_pretty(pg_relation_size(c.oid)) as size from pg_class c where c.relname in ('questions_invoice','questions_open','extractions_invoice','jobs_invoice')`,
  );
  console.log('\ncandidate index sizes:', Object.fromEntries(sizes.map((r) => [r.name, r.size])));
  await plans('with the candidate indexes');
}

await client.end();
await h.close();
process.exit(0);
