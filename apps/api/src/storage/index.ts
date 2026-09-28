import type { StorageConfig } from '../config';
import { LocalDocumentStorage } from './local';
import { S3DocumentStorage } from './s3';
import type { DocumentStorage } from './storage';

export * from './storage';
export { LocalDocumentStorage } from './local';
export { S3DocumentStorage } from './s3';

/** The storage the configuration names (Phase 6). */
export function createStorage(config: StorageConfig): DocumentStorage {
  if (config.kind === 's3') {
    if (!config.s3) throw new Error('s3 storage selected without its settings');
    return new S3DocumentStorage(config.s3);
  }
  return new LocalDocumentStorage(config.dir);
}
