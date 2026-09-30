import { ApiInstanceSchema, type ApiInstance } from '@veyra/shared';
import { API, API_CREDENTIALS } from '../api-endpoint';

/**
 * Whether a Veyrafy instance answers at this address (GET /api/v1/instance). `missing`: nothing is
 * set up here (no such endpoint, or not a Veyrafy instance). `unavailable`: something is, but it
 * cannot answer right now (network, 5xx). Never guessed: only a response matching the strict
 * schema confirms an instance.
 */
export type InstanceCheck =
  { status: 'ready'; instance: ApiInstance } | { status: 'missing' } | { status: 'unavailable' };

export async function checkInstance(fetcher: typeof fetch = fetch): Promise<InstanceCheck> {
  let res: Response;
  try {
    res = await fetcher(`${API.base}/instance`, {
      credentials: API_CREDENTIALS,
      headers: { accept: 'application/json' },
    });
  } catch {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    // The body is not needed; release it so the request completes at once.
    void res.body?.cancel().catch(() => undefined);
    return res.status >= 500 ? { status: 'unavailable' } : { status: 'missing' };
  }
  try {
    const parsed = ApiInstanceSchema.safeParse(await res.json());
    return parsed.success ? { status: 'ready', instance: parsed.data } : { status: 'missing' };
  } catch {
    return { status: 'missing' };
  }
}
