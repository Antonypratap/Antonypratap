/**
 * Before/after comparison of two benchmark runs (docs/PERFORMANCE.md):
 *
 *   npx tsx bench/compare.ts baseline after
 *
 * Prints every metric present in both runs with p50/p95/p99 side by side and the change.
 */
import { readFileSync } from 'node:fs';

const [a = 'baseline', b = 'after'] = process.argv.slice(2);
const load = (label: string) =>
  JSON.parse(readFileSync(new URL(`./results/${label}.json`, import.meta.url), 'utf8')) as unknown;

type Stats = { p50: number; p95: number; p99: number; n: number };
const isStats = (x: unknown): x is Stats =>
  typeof x === 'object' && x !== null && 'p50' in x && 'p95' in x && 'n' in x;

function flatten(x: unknown, prefix = '', out = new Map<string, Stats>()) {
  if (isStats(x)) out.set(prefix, x);
  else if (x && typeof x === 'object')
    for (const [k, v] of Object.entries(x)) flatten(v, prefix ? `${prefix} › ${k}` : k, out);
  return out;
}

const before = flatten(load(a));
const after = flatten(load(b));
const pct = (x: number, y: number) =>
  x === 0 ? '' : `${y <= x ? '−' : '+'}${Math.abs(Math.round(((y - x) / x) * 100))}%`;
console.log(
  `${'metric'.padEnd(78)} ${'p50'.padStart(20)} ${'p95'.padStart(20)} ${'p99'.padStart(20)}`,
);
for (const [key, x] of before) {
  const y = after.get(key);
  if (!y || x.n === 0) continue;
  const cell = (k: 'p50' | 'p95' | 'p99') => `${x[k]}→${y[k]} ${pct(x[k], y[k])}`.padStart(20);
  console.log(`${key.slice(0, 78).padEnd(78)} ${cell('p50')} ${cell('p95')} ${cell('p99')}`);
}
