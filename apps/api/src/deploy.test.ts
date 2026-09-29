import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Phase 7C: the API container image (apps/api/Dockerfile, docs/DEPLOYMENT.md §14) stays in step
 * with the repository and holds no secret.
 */
const root = new URL('../../../', import.meta.url);
const dockerfile = readFileSync(new URL('apps/api/Dockerfile', root), 'utf8');
const dockerignore = readFileSync(new URL('.dockerignore', root), 'utf8');

describe('API container image', () => {
  it('installs every workspace from the lockfile (a new package cannot be forgotten)', () => {
    const workspaces = ['apps', 'packages'].flatMap((dir) =>
      readdirSync(new URL(`${dir}/`, root)).map((name) => `${dir}/${name}`),
    );
    for (const ws of workspaces) expect(dockerfile, ws).toContain(`COPY ${ws}/package.json ${ws}/`);
    expect(dockerfile).toContain('npm ci');
  });

  it('runs as an unprivileged user, Node receiving SIGTERM directly, data on a volume', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/^VOLUME \["\/var\/lib\/veyra"\]$/m);
    expect(dockerfile).toMatch(/^CMD \["node", "--import", "tsx", "apps\/api\/src\/main\.ts"\]$/m);
  });

  it('holds no secret and copies no local data or environment file', () => {
    // ENV and ARG values end up in the image's metadata: none may carry configuration secrets.
    const settings = dockerfile
      .split('\n')
      .filter((l) => /^\s*(ENV|ARG)\b/.test(l) || /^\s+[A-Z_]+=/.test(l))
      .join('\n');
    expect(settings).toContain('VEYRA_DATA_DIR=/var/lib/veyra');
    expect(settings).not.toMatch(/DATABASE_URL|DEMO_PIN|PASSWORD|SECRET|TOKEN|KEY/i);
    for (const excluded of ['.git', '**/node_modules', 'data', '.env', '.env.*', '**/*.db'])
      expect(dockerignore.split('\n')).toContain(excluded);
    expect(dockerignore.split('\n')).toContain('!.env.example');
  });
});
