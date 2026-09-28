/**
 * Repository health check (Phase 0).
 *
 * Verifies the toolchain and workspace wiring: Node version satisfies `engines`,
 * every workspace has the expected files, and each workspace entry point resolves
 * through npm workspaces and reports its own package name.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface PackageJson {
  name: string;
  engines?: { node?: string };
  workspaces?: string[];
}

const root = join(import.meta.dirname, '..');
const readJson = (path: string): PackageJson =>
  JSON.parse(readFileSync(path, 'utf8')) as PackageJson;

const rootPkg = readJson(join(root, 'package.json'));
const failures: string[] = [];
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures.push(label);
};

const parseVersion = (v: string): number[] =>
  v
    .replace(/^[^\d]*/, '')
    .split('.')
    .map(Number);
const atLeast = (actual: number[], min: number[]): boolean => {
  for (let i = 0; i < min.length; i++) {
    const a = actual[i] ?? 0;
    const m = min[i] ?? 0;
    if (a !== m) return a > m;
  }
  return true;
};
const minNode = rootPkg.engines?.node ?? '>=20';
check(
  atLeast(parseVersion(process.version), parseVersion(minNode)),
  `node ${process.version} satisfies ${minNode}`,
);

const workspaceDirs = (rootPkg.workspaces ?? []).flatMap((pattern) => {
  const base = pattern.replace(/\/\*$/, '');
  return readdirSync(join(root, base), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(base, d.name));
});
check(workspaceDirs.length > 0, `found ${workspaceDirs.length} workspaces`);

for (const dir of workspaceDirs) {
  const pkg = readJson(join(root, dir, 'package.json'));
  for (const file of ['tsconfig.json', 'src/index.ts']) {
    check(existsSync(join(root, dir, file)), `${pkg.name}: ${file} present`);
  }
  const mod = (await import(pkg.name)) as { PACKAGE_NAME?: unknown };
  check(mod.PACKAGE_NAME === pkg.name, `${pkg.name}: resolves via workspace link`);
}

if (failures.length > 0) {
  console.error(`\nhealth: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nhealth: OK');
