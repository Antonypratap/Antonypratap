import { z } from 'zod';
import {
  ApiChallengeConfigSchema,
  ApiChallengeStateSchema,
  type ApiChallengeConfig,
  type ApiChallengeState,
  type ChallengeDetails,
} from '@veyra/shared';
import { API, API_CREDENTIALS } from '../api-endpoint';
import { ApiError } from '../product/api/client';

/**
 * The 5 Invoice Challenge's calls. No account: the server keeps the challenge's secret in an
 * HttpOnly cookie scoped to the challenge API, which this code never reads or stores. Every change
 * carries the `x-veyra-challenge-request` header (another site cannot send it). The results link
 * in the e-mail carries its secret in the URL fragment, which no browser sends to a server: it is
 * handed to the server once (claim) and removed from the address bar at once.
 */
const BASE = `${API.base}/challenge`;
const REQUEST = { 'x-veyra-challenge-request': '1' };

/** The secret of an e-mailed results link, taken out of the address bar (not kept anywhere). */
export function takeLinkSecret(): string | null {
  const m = /(?:^|[#&])access=([A-Za-z0-9_-]{43})/.exec(window.location.hash);
  if (!m?.[1]) return null;
  history.replaceState(null, '', window.location.pathname);
  return m[1];
}

const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      credentials: API_CREDENTIALS,
      headers: { ...(init.headers as Record<string, string>), ...REQUEST },
    });
  } catch {
    throw new ApiError(
      0,
      'OFFLINE',
      'Veyrafy could not be reached. Check your connection and try again.',
    );
  }
  if (!res.ok) {
    const body = ErrorBody.safeParse(await res.json().catch(() => null));
    throw body.success
      ? new ApiError(
          res.status,
          body.data.error.code,
          body.data.error.message,
          body.data.error.details ?? {},
        )
      : new ApiError(res.status, 'HTTP', 'Something went wrong. Please try again.');
  }
  return res;
}
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const file = (f: File): RequestInit => {
  const form = new FormData();
  form.append('file', f, f.name);
  return { method: 'POST', body: form };
};
const state = async (res: Response): Promise<ApiChallengeState> =>
  ApiChallengeStateSchema.parse(await res.json());

export const challengeApi = {
  config: async (): Promise<ApiChallengeConfig> =>
    ApiChallengeConfigSchema.parse(await (await call('/config')).json()),
  /** Starts a challenge on the prospect's consent (nothing else is asked before the results). */
  create: async () =>
    z
      .object({ state: ApiChallengeStateSchema })
      .parse(await (await call('', json({ consent: true }))).json()).state,
  /** Who the report is for: opens the full results. */
  details: async (details: ChallengeDetails) => state(await call('/me/details', json(details))),
  claim: async (secret: string) => state(await call('/claim', json({ token: secret }))),
  me: async () => state(await call('/me')),
  uploadInvoice: async (f: File) => state(await call('/me/invoices', file(f))),
  removeInvoice: async (id: string) =>
    state(await call(`/me/invoices/${encodeURIComponent(id)}/remove`, { method: 'POST' })),
  retryInvoice: async (id: string) =>
    state(await call(`/me/invoices/${encodeURIComponent(id)}/retry`, { method: 'POST' })),
  addRecords: async (f: File) => state(await call('/me/records', file(f))),
  start: async (gstin: string) => state(await call('/me/start', json({ gstin }))),
  interest: async (kind: 'walkthrough' | 'pilot') =>
    state(await call('/me/interest', json({ kind }))),
  /** A page of an uploaded invoice (the browser sends the challenge cookie; same origin). */
  pageUrl: (documentId: string, page: number) =>
    `${BASE}/me/documents/${encodeURIComponent(documentId)}/pages/${page}`,
  /** Downloads the PDF report. */
  downloadReport: async (company: string): Promise<void> => {
    const res = await call('/me/report.pdf');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `Veyrafy-Invoice-Verification-Report-${company.replace(/[^A-Za-z0-9]+/g, '-')}.pdf`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
  templateUrl: (fileName: string) => `${BASE}/templates/${encodeURIComponent(fileName)}`,
};
