import type { StorageConfig } from '../config';
import { LocalDocumentStorage } from './local';
import type { DocumentStorage } from './storage';

export * from './storage';
export { LocalDocumentStorage } from './local';

/**
 * The storage the configuration names (Phase 6B). Only local storage exists; an object-storage
 * adapter would be another DocumentStorage implementation chosen here.
 */
export function createStorage(config: StorageConfig): DocumentStorage {
  return new LocalDocumentStorage(config.dir);
}
