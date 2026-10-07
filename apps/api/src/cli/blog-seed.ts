/**
 * Creates the blog's starting structure (`npm run blog:seed -w @veyra/api`): six categories, an
 * author byline and eight complete articles as DRAFTS (docs/BLOG.md). Drafts only: nothing becomes
 * public until an editor publishes it from the studio. Running it
 * again creates only what is missing.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, cliDatabase } from '../config';
import { openVeyraDb } from '../db/open';
import { BlogService } from '../blog/service';
import { seedBlog } from '../blog/seed';

try {
  const config = cliDatabase(process.env, {
    dataDir: fileURLToPath(new URL('../../../../data/veyra', import.meta.url)),
  });
  const database = await openVeyraDb({
    url: config.database.url?.reveal() ?? null,
    pgliteDir: join(config.dataDir, 'pgdata'),
    migrate: false,
    pool: { ...config.database.pool, max: 1 },
  });
  try {
    const created = await seedBlog(new BlogService({ db: database.db }));
    console.log(
      `Blog: created ${created.categories} categor${created.categories === 1 ? 'y' : 'ies'}, ${created.authors} author(s), ${created.articles} draft article(s).`,
    );
  } finally {
    await database.close();
  }
} catch (error) {
  console.error(
    error instanceof ConfigError
      ? error.message
      : `Blog seed failed: ${error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/g, '[database]') : 'unknown error'}`,
  );
  process.exit(1);
}
