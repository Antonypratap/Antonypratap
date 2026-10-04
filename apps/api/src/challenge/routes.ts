import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApiChallengeConfigSchema,
  ApiChallengeStateSchema,
  ChallengeDetailsSchema,
} from '@veyra/shared';
import { templateWorkbook } from '../imports/templates';
import { VeyraError } from '../workflow/veyra';
import type { ChallengeService } from './service';

/**
 * The 10 Invoice Challenge's API: `/api/v1/challenge/*`. No account: the challenge's secret token
 * is held by the browser in an HttpOnly cookie scoped to this API (page scripts never see or
 * store it), or sent by an API client in the `x-veyra-challenge` header. Never in a URL. A change
 * made with the cookie must carry the `x-veyra-challenge-request` header, which another site
 * cannot send, so a cross-site request cannot act on a challenge. Every request finds the
 * challenge by the token's hash and works only in that challenge's own workspace: one company
 * never reaches another's invoices.
 */
export const CHALLENGE_TOKEN_HEADER = 'x-veyra-challenge';
export const CHALLENGE_REQUEST_HEADER = 'x-veyra-challenge-request';
export const CHALLENGE_COOKIE = 'veyra_challenge';
const PUBLIC = { config: { access: 'public' } } as const;
const Id = z.object({ id: z.string().min(1).max(64) });

export function registerChallengeRoutes(
  app: FastifyInstance,
  challenge: ChallengeService,
  opts: { cookieSecure: boolean },
): void {
  const tokenOf = (req: FastifyRequest): { token: string | undefined; viaCookie: boolean } => {
    const header = req.headers[CHALLENGE_TOKEN_HEADER];
    const h = Array.isArray(header) ? header[0] : header;
    if (h) return { token: h, viaCookie: false };
    return { token: req.cookies[CHALLENGE_COOKIE], viaCookie: true };
  };
  const guard = (req: FastifyRequest, viaCookie: boolean) => {
    if (viaCookie && req.method !== 'GET' && req.headers[CHALLENGE_REQUEST_HEADER] !== '1')
      throw new VeyraError('FORBIDDEN', 'This request was not made from the challenge page.');
  };
  const mine = async (req: FastifyRequest) => {
    const { token, viaCookie } = tokenOf(req);
    guard(req, viaCookie);
    return challenge.byToken(token);
  };
  const keep = (reply: FastifyReply, token: string, expiresAt: string) =>
    reply.setCookie(CHALLENGE_COOKIE, token, {
      httpOnly: true,
      secure: opts.cookieSecure,
      sameSite: 'strict',
      path: '/api/v1/challenge',
      expires: new Date(expiresAt),
    });
  const state = async (req: FastifyRequest) =>
    ApiChallengeStateSchema.parse(await challenge.state(await mine(req)));
  const fileOf = async (req: FastifyRequest) => {
    const file = await req.file();
    if (!file) throw new VeyraError('INVALID_INPUT', 'Attach a file.');
    return { filename: file.filename, bytes: new Uint8Array(await file.toBuffer()) };
  };

  app.get('/api/v1/challenge/config', PUBLIC, async () =>
    ApiChallengeConfigSchema.parse(challenge.config()),
  );

  // Start: the details, and consent to how the invoices are processed and kept.
  app.post('/api/v1/challenge', PUBLIC, async (req, reply) => {
    guard(req, true);
    const details = ChallengeDetailsSchema.parse(req.body ?? {});
    const { token, challenge: row } = await challenge.create(details);
    keep(reply, token, row.expiresAt);
    return reply.status(201).send({
      token,
      state: ApiChallengeStateSchema.parse(await challenge.state(row)),
    });
  });

  app.get('/api/v1/challenge/me', PUBLIC, async (req) => state(req));

  // The results link in the e-mail: its token (from the URL fragment) becomes this browser's.
  app.post('/api/v1/challenge/claim', PUBLIC, async (req, reply) => {
    guard(req, true);
    const { token } = z
      .object({ token: z.string().max(64) })
      .strict()
      .parse(req.body ?? {});
    const row = await challenge.byToken(token);
    keep(reply, token, row.expiresAt);
    return ApiChallengeStateSchema.parse(await challenge.state(row));
  });

  app.post('/api/v1/challenge/me/invoices', PUBLIC, async (req, reply) => {
    await challenge.uploadInvoice(await mine(req), await fileOf(req));
    return reply.status(201).send(await state(req));
  });
  app.post('/api/v1/challenge/me/invoices/:id/remove', PUBLIC, async (req) => {
    await challenge.removeInvoice(await mine(req), Id.parse(req.params).id);
    return state(req);
  });
  app.post('/api/v1/challenge/me/invoices/:id/retry', PUBLIC, async (req) => {
    await challenge.retryInvoice(await mine(req), Id.parse(req.params).id);
    return state(req);
  });

  app.post('/api/v1/challenge/me/records', PUBLIC, async (req) => {
    await challenge.addRecords(await mine(req), await fileOf(req));
    return state(req);
  });
  // The record templates (the product's own), so a prospect can fill in their records.
  app.get('/api/v1/challenge/templates/:file', PUBLIC, async (req, reply) => {
    const { file } = z.object({ file: z.string().max(80) }).parse(req.params);
    const bytes = templateWorkbook(file);
    if (!bytes) throw new VeyraError('NOT_FOUND', 'No such template.');
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${file}"`)
      .send(bytes);
  });

  app.post('/api/v1/challenge/me/start', PUBLIC, async (req) => {
    const { gstin } = z
      .object({ gstin: z.string().trim().max(20) })
      .strict()
      .parse(req.body ?? {});
    await challenge.startChecks(await mine(req), gstin);
    return state(req);
  });

  // One page of an uploaded invoice (the evidence viewer). Only this challenge's documents.
  app.get('/api/v1/challenge/me/documents/:id/pages/:page', PUBLIC, async (req, reply) => {
    const { id, page } = z
      .object({ id: z.string().min(1).max(64), page: z.coerce.number().int().min(1).max(500) })
      .parse(req.params);
    const p = await challenge.page(await mine(req), id, page);
    return reply
      .header('content-type', p.mime)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .header('content-security-policy', "default-src 'none'; frame-ancestors 'self'; sandbox")
      .send(p.body);
  });

  app.get('/api/v1/challenge/me/report.pdf', PUBLIC, async (req, reply) => {
    const ch = await mine(req);
    const pdf = await challenge.report(ch);
    const name = `Veyrafy-Invoice-Verification-Report-${ch.companyName.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60)}.pdf`;
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(pdf);
  });

  app.post('/api/v1/challenge/me/interest', PUBLIC, async (req) => {
    const { kind } = z
      .object({ kind: z.enum(['walkthrough', 'pilot']) })
      .strict()
      .parse(req.body ?? {});
    await challenge.interest(await mine(req), kind);
    return state(req);
  });
}
