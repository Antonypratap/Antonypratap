/**
 * Secret scan (Phase 6C, `npm run secrets:scan`, part of `npm run check` and CI).
 *
 * Scans every file git tracks (and the web build, if present) for credentials that must never be
 * committed or shipped to the browser: private keys, cloud and SaaS tokens, database URLs with a
 * real-looking password, and tracked `.env` files. Exits non-zero naming file and rule, never the
 * matched value.
 *
 * Limitations (docs/SECURITY.md "Dependency and secret scanning"): pattern-based, so it finds known
 * token shapes and obvious credentials, not every secret; it does not scan git history; it does not
 * look at files git ignores. Use the hosting provider's secret scanning as well.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface Rule {
  name: string;
  pattern: RegExp;
  /** Files the rule does not apply to (tests hold deliberately fake credentials). */
  skip?: RegExp;
}

/** Placeholder or test-only database passwords that may appear in docs, examples and tests. */
const PLACEHOLDER_PASSWORDS = new Set(['veyra_test', 'CHANGE_ME', 'change_me', 'password']);

const RULES: Rule[] = [
  {
    name: 'private key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  },
  { name: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    name: 'GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
  },
  { name: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'OpenAI/Anthropic key', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: 'Stripe live key', pattern: /\b[rs]k_live_[0-9A-Za-z]{24,}\b/ },
  {
    name: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
];

/** A database URL with an inline password that is not a known placeholder. */
function databasePassword(text: string): boolean {
  for (const m of text.matchAll(/postgres(?:ql)?:\/\/[^:@\s/'"`]+:([^@\s'"`]+)@/g)) {
    const password = m[1] ?? '';
    if (!PLACEHOLDER_PASSWORDS.has(password) && !/^[$<{]/.test(password)) return true;
  }
  return false;
}

const TEST_FILE = /\.test\.tsx?$|\/test\/|\/fixtures\//;
const BINARY = /\.(png|jpe?g|gif|webp|pdf|xlsx|woff2?|ico|db|sqlite)$/i;

const tracked = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);

const webBuild: string[] = [];
const walk = (dir: string) => {
  for (const e of readdirSync(dir, { withFileTypes: true }))
    if (e.isDirectory()) walk(join(dir, e.name));
    else webBuild.push(join(dir, e.name));
};
if (existsSync('apps/web/dist')) walk('apps/web/dist');

const findings: string[] = [];
for (const file of tracked)
  if (/(^|\/)\.env(\.|$)/.test(file) && !file.endsWith('.env.example'))
    findings.push(`${file}: an environment file is tracked by git`);

for (const file of [...tracked, ...webBuild]) {
  if (BINARY.test(file) || !existsSync(file) || statSync(file).size > 5_000_000) continue;
  const text = readFileSync(file, 'utf8');
  for (const rule of RULES)
    if (!(rule.skip?.test(file) ?? false) && rule.pattern.test(text))
      findings.push(`${file}: ${rule.name}`);
  if (!TEST_FILE.test(file) && databasePassword(text))
    findings.push(`${file}: database URL with a password`);
}
// The browser bundle must not carry server configuration names at all.
for (const file of webBuild.filter((f) => /\.(js|html|css|map)$/.test(f))) {
  const text = readFileSync(file, 'utf8');
  if (/DATABASE_URL|VEYRA_DEMO_PIN|VEYRA_ERP_|password_hash|argon2/.test(text))
    findings.push(`${file}: server-side configuration or credential material in the web build`);
}

if (findings.length) {
  console.error(`Secret scan: ${findings.length} finding(s) (values not shown):`);
  for (const f of findings) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `Secret scan: no findings in ${tracked.length} repository files${webBuild.length ? ` and ${webBuild.length} web build files` : ''}.`,
);
