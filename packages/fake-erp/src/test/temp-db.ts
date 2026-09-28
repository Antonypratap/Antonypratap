import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeErpConnector, type FakeErpOptions } from '../index';

/** A throw-away fake_erp.db file (a file, not :memory:, so restarts can be simulated). */
export function tempErp(options: Omit<FakeErpOptions, 'filename'> = {}): {
  filename: string;
  erp: FakeErpConnector;
  open: (more?: Omit<FakeErpOptions, 'filename'>) => FakeErpConnector;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-fake-erp-'));
  const filename = join(dir, 'fake_erp.db');
  const opened: FakeErpConnector[] = [];
  const open = (more: Omit<FakeErpOptions, 'filename'> = {}): FakeErpConnector => {
    const c = FakeErpConnector.open({ filename, ...more });
    opened.push(c);
    return c;
  };
  const erp = open(options);
  return {
    filename,
    erp,
    open,
    cleanup: () => {
      for (const c of opened) c.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
