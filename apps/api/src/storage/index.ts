import type { StorageConfig } from '../config';
import { EncryptedDocumentStorage } from './encrypted';
import { Keyring } from './keyring';
import { LocalDocumentStorage } from './local';
import type { DocumentStorage } from './storage';

export * from './storage';
export { LocalDocumentStorage } from './local';
export { EncryptedDocumentStorage } from './encrypted';
export { Keyring, KeyringError } from './keyring';

/**
 * The storage the configuration names: a folder, wrapped so every file is encrypted at rest when
 * data keys are configured (always in production). `dir` overrides the folder (challenge
 * workspaces keep their files in their own folder, under the same keys).
 */
export function createStorage(config: StorageConfig, dir: string = config.dir): DocumentStorage {
  const local = new LocalDocumentStorage(dir);
  if (!config.encryption) return local;
  return new EncryptedDocumentStorage(local, {
    keyring: Keyring.parse(config.encryption.keys, config.encryption.activeId),
    requireEncrypted: config.encryption.requireEncrypted,
  });
}
