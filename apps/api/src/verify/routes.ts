import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiRequestError, maxSubmitBytes, type VerificationService } from './service';

/**
 * The Client Invoice Verification API (docs/VERIFY-API.md). Callers are software holding an API
 * key (route access `api_client`), never a browser session; every result belongs to the client
 * that submitted it, and another client's id answers 404 exactly like an unknown one.
 */

const ID = z.object({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) });
const API = { config: { access: 'api_client' as const } };

export function registerVerifyRoutes(
  app: FastifyInstance,
  deps: {
    service: VerificationService;
    maxUploadBytes: number;
    /** Per-client rate limit (requests counted against the client, not only its address). */
    hit: (client: string) => number | null;
  },
): void {
  const { service } = deps;
  const clientOf = (req: FastifyRequest) => {
    if (!req.apiClient)
      throw new ApiRequestError(401, 'UNAUTHENTICATED', 'A valid Veyrafy API key is required.');
    return req.apiClient;
  };
  const notFound = () =>
    new ApiRequestError(404, 'NOT_FOUND', 'There is no such verification for this API key.');
  const location = (id: string) => `/api/v1/verification/${id}`;

  // The invoice may travel as base64 inside the reference, so this route takes larger bodies than
  // the API's default; only an authenticated client's body is ever read (access runs first).
  const bodyLimit = maxSubmitBytes(deps.maxUploadBytes);

  app.post('/api/v1/verify', { ...API, bodyLimit }, async (req, reply) => {
    const client = clientOf(req);
    const wait = deps.hit(client.id);
    if (wait !== null) {
      void reply.header('retry-after', String(wait));
      throw new ApiRequestError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.');
    }
    const header = req.headers['idempotency-key'];
    const idempotencyKey = typeof header === 'string' ? header.trim() : undefined;
    const accepted = async (input: {
      referenceId: unknown;
      reference: unknown;
      invoice: { bytes: Uint8Array } | null;
    }) => {
      const { view, replayed } = await service.submit(client, { ...input, idempotencyKey });
      req.log.info(
        { verificationId: view.verification_id, replayed },
        replayed ? 'verification replayed' : 'verification accepted',
      );
      return reply
        .status(replayed ? 200 : 202)
        .header('location', location(view.verification_id))
        .header('cache-control', 'no-store')
        .send(view);
    };

    // JSON: the client's own export with `reference_id` beside `data`, the invoice in `images`.
    if (!req.isMultipart()) {
      const body: unknown = req.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body))
        throw new ApiRequestError(
          400,
          'INVALID_REQUEST',
          'Send JSON (reference_id and data) or multipart/form-data (invoice, reference_json and reference_id).',
        );
      const { reference_id: referenceId, ...reference } = body as Record<string, unknown>;
      return accepted({ referenceId, reference, invoice: null });
    }

    const fields: Record<string, string> = {};
    let invoice: { bytes: Uint8Array } | null = null;
    for await (const part of req.parts({
      limits: {
        fileSize: deps.maxUploadBytes,
        files: 1,
        fields: 2,
        parts: 3,
        fieldSize: bodyLimit,
      },
    })) {
      if (part.type === 'file') {
        if (part.fieldname !== 'invoice') {
          await part.toBuffer().catch(() => undefined);
          throw new ApiRequestError(
            400,
            'INVALID_REQUEST',
            'The only file accepted is "invoice".',
            {
              field: part.fieldname,
            },
          );
        }
        invoice = { bytes: new Uint8Array(await part.toBuffer()) };
      } else {
        if (part.fieldname !== 'reference_json' && part.fieldname !== 'reference_id')
          throw new ApiRequestError(400, 'INVALID_REQUEST', 'Unknown form field.', {
            field: part.fieldname,
          });
        if (part.valueTruncated)
          throw new ApiRequestError(413, 'TOO_LARGE', `${part.fieldname} is too large.`, {
            field: part.fieldname,
          });
        fields[part.fieldname] = typeof part.value === 'string' ? part.value : '';
      }
    }
    return accepted({
      referenceId: fields.reference_id,
      reference: fields.reference_json,
      invoice,
    });
  });

  app.get('/api/v1/verification/:id', API, async (req, reply) => {
    const client = clientOf(req);
    const parsed = ID.safeParse(req.params);
    if (!parsed.success) throw notFound();
    const view = await service.get(client.id, parsed.data.id);
    if (!view) throw notFound();
    if (view.processing_status === 'processing') void reply.header('retry-after', '2');
    return reply.header('cache-control', 'no-store').send(view);
  });

  app.delete('/api/v1/verification/:id', API, async (req, reply) => {
    const client = clientOf(req);
    const parsed = ID.safeParse(req.params);
    if (!parsed.success) throw notFound();
    if (!(await service.delete(client.id, parsed.data.id))) throw notFound();
    return reply.status(204).send();
  });
}
