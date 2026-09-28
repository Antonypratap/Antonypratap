/**
 * Deterministic demo reset of fake_erp.db:
 *   npm run erp:reset                  → <repo>/data/fake_erp.db
 *   npm run erp:reset -- <path>        → the given file
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { FakeErpConnector } from '../connector';

const target = process.argv[2]
  ? resolve(process.argv[2])
  : join(import.meta.dirname, '..', '..', '..', '..', 'data', 'fake_erp.db');
mkdirSync(dirname(target), { recursive: true });
const erp = FakeErpConnector.open({ filename: target, reset: 'demo' });
const company = await erp.getCompany();
erp.close();
console.log(`fake ERP reset with DEMO.md seed for ${company.name} → ${target}`);
