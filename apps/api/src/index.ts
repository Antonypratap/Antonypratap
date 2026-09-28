/**
 * @veyra/api: Veyra REST API and workflow core: extraction, matching, resolution, validation,
 * questions and commit (ARCHITECTURE §1).
 */
export const PACKAGE_NAME = '@veyra/api';

export { createApp, type AppConfig } from './app';
export { buildServer } from './http/server';
export { Veyra } from './workflow/veyra';
