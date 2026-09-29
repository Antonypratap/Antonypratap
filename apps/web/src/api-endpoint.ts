import { parseApiBase } from './api-base';

/** The API this build talks to (VITE_API_BASE_URL, validated at build time; see api-base.ts). */
export const API = parseApiBase(import.meta.env.VITE_API_BASE_URL as string | undefined);

/** Cookies go with every request to the API; across origins only because the API allows it. */
export const API_CREDENTIALS: RequestCredentials = API.origin ? 'include' : 'same-origin';
