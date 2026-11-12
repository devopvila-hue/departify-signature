/**
 * HTTP layer: Fastify routes exposing the signature service.
 *
 * The API is intentionally small and explicit so a DEPARTIFY CRM integration
 * (or an MCP tool) can drive the whole flow with plain HTTP calls.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import {
  createEnvelopeSchema,
  signRequestSchema,
  type EnvelopeDetail,
} from '@signatureit/shared';
import { DomainError, SignatureService } from './service.js';
import type { Store } from './store.js';

export interface BuildServerOptions {
  store: Store;
  service: SignatureService;
  logger?: boolean;
  production?: boolean;
}

/** Extracts request metadata used in the audit trail. */
function actorContext(request: { ip?: string; headers: Record<string, unknown> }) {
  return {
    ip: request.ip,
    userAgent:
      typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
  };
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { service, store } = options;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 24 * 1024 * 1024 });

  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });

  // The API is JSON, but several endpoints take no body at all. Fastify's
  // default parser rejects an empty JSON body and any unknown content type,
  // which would break plain `curl -X POST` calls from an integration script.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      const raw = typeof body === 'string' ? body.trim() : '';
      if (!raw) return done(null, undefined);
      try {
        done(null, JSON.parse(raw));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, _body, done) => done(null, undefined),
  );
  app.addContentTypeParser(
    '*',
    { parseAs: 'string' },
    (_request, _body, done) => done(null, undefined),
  );

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof DomainError) {
      return reply.status(error.statusCode).send({ error: error.code, message: error.message });
    }
    const maybeValidation = (error as { validation?: unknown }).validation;
    if (maybeValidation) {
      return reply.status(400).send({ error: 'validation_error', message: String((error as Error).message) });
    }
    // Fastify's own client errors (unsupported media type, payload too
    // large, bad request) keep their status instead of becoming a 500.
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.status(status).send({
        error: (error as { code?: string }).code ?? 'bad_request',
        message: String((error as Error).message),
      });
    }
    request.log.error(error);
    return reply.status(500).send({ error: 'internal_error', message: 'Unexpected server error.' });
  });

  /* ------------------------------- health --------------------------------- */

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'departify-signature',
    time: new Date().toISOString(),
  }));

  /* ------------------------------ envelopes ------------------------------- */

  app.get('/api/envelopes', async () => ({ envelopes: service.listEnvelopes() }));

  app.post('/api/envelopes', async (request, reply) => {
    const parsed = createEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      });
    }
    if (options.production && parsed.data.signatureLevel !== 'simple') {
      return reply.status(409).send({ error: 'signature_level_unavailable', message: 'Only simple signatures are available. No OTP or trust service is connected.' });
    }
    const envelope = await service.createEnvelope(parsed.data, actorContext(request));
    return reply.status(201).send({ envelope });
  });

  app.get<{ Params: { id: string } }>('/api/envelopes/:id', async (request, reply) => {
    const envelope = service.getEnvelopeDetail(request.params.id);
    if (!envelope) return reply.status(404).send({ error: 'not_found', message: 'Signature request not found.' });
    return { envelope };
  });

  app.post<{ Params: { id: string } }>('/api/envelopes/:id/send', async (request, reply) => {
    try {
      const envelope = service.sendEnvelope(request.params.id, actorContext(request));
      return { envelope, links: signingLinks(envelope) };
    } catch (error) {
      if (error instanceof DomainError) {
        return reply.status(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/api/envelopes/:id/remind', async (request, reply) => {
    try {
      return { envelope: service.remindEnvelope(request.params.id, actorContext(request)) };
    } catch (error) {
      if (error instanceof DomainError) {
        return reply.status(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/api/envelopes/:id/cancel', async (request, reply) => {
    try {
      return { envelope: service.cancelEnvelope(request.params.id, actorContext(request)) };
    } catch (error) {
      if (error instanceof DomainError) {
        return reply.status(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>('/api/envelopes/:id/audit', async (request, reply) => {
    const envelope = service.getEnvelopeDetail(request.params.id);
    if (!envelope) return reply.status(404).send({ error: 'not_found', message: 'Signature request not found.' });
    return { audit: envelope.audit, verification: service.verifyAudit(request.params.id) };
  });

  app.get<{ Params: { id: string } }>('/api/envelopes/:id/audit/verify', async (request, reply) => {
    const envelope = service.getEnvelopeDetail(request.params.id);
    if (!envelope) return reply.status(404).send({ error: 'not_found', message: 'Signature request not found.' });
    return { verification: service.verifyAudit(request.params.id) };
  });

  app.get<{ Params: { id: string } }>('/api/envelopes/:id/document', async (request, reply) => {
    const document = service.getEnvelopeDocument(request.params.id);
    if (!document) return reply.status(404).send({ error: 'not_found', message: 'Document not found.' });
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="${encodeURIComponent(document.fileName)}"`)
      .send(document.content);
  });

  app.get<{ Params: { id: string }; Querystring: { inline?: string } }>(
    '/api/envelopes/:id/signed',
    async (request, reply) => {
      const signed = service.getSignedDocument(request.params.id);
      if (!signed) {
        return reply.status(404).send({ error: 'not_found', message: 'The signed document is not ready yet.' });
      }
      // `?inline=1` previews the signed PDF in the browser instead of
      // downloading it, which is handy to check the certificate page.
      const disposition = request.query.inline === '1' ? 'inline' : 'attachment';
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `${disposition}; filename="${encodeURIComponent(signed.fileName)}"`)
        .send(signed.content);
    },
  );

  /* ------------------------------ signing room ---------------------------- */

  app.get<{ Params: { token: string } }>('/api/signing/:token', async (request, reply) => {
    try {
      return { room: service.getSigningRoom(request.params.token, actorContext(request)) };
    } catch (error) {
      if (error instanceof DomainError) {
        return reply.status(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { token: string } }>('/api/signing/:token/document', async (request, reply) => {
    try {
      const document = service.getSigningDocument(request.params.token);
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `inline; filename="${encodeURIComponent(document.fileName)}"`)
        .send(document.content);
    } catch (error) {
      if (error instanceof DomainError) {
        return reply.status(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { token: string } }>('/api/signing/:token/otp', async (request, reply) => {
    if (options.production) return reply.status(409).send({ error: 'otp_unavailable' });
    try {
      return service.requestOtp(request.params.token, actorContext(request));
    } catch (error) {
      if (error instanceof DomainError) {
        return reply.status(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { token: string } }>('/api/signing/:token/otp/verify', async (request, reply) => {
    if (options.production) return reply.status(409).send({ error: 'otp_unavailable' });
    const body = request.body as { code?: string } | undefined;
    try {
      return service.verifyOtp(request.params.token, String(body?.code ?? ''), actorContext(request));
    } catch (error) {
      if (error instanceof DomainError) {
        return reply.status(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { token: string } }>('/api/signing/:token/sign', async (request, reply) => {
    const parsed = signRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      });
    }
    try {
      const envelope = await service.sign(request.params.token, parsed.data, actorContext(request));
      return { envelope: { id: envelope.id, status: envelope.status } };
    } catch (error) {
      if (error instanceof DomainError) {
        return reply.status(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { token: string } }>('/api/signing/:token/decline', async (request, reply) => {
    const body = request.body as { reason?: string } | undefined;
    try {
      return {
        envelope: (() => {
          const result = service.decline(request.params.token, String(body?.reason ?? 'The signer declined to sign.'), actorContext(request));
          return { id: result.id, status: result.status };
        })(),
      };
    } catch (error) {
      if (error instanceof DomainError) {
        return reply.status(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  /* --------------------------------- utils -------------------------------- */

  app.get('/api/db/stats', async () => ({
    documents: store.listEnvelopes().length,
    envelopes: store.listEnvelopes().length,
  }));

  return app;
}

/** Builds the per-recipient signing links returned after sending. */
function signingLinks(envelope: EnvelopeDetail) {
  return envelope.recipients.map((recipient) => ({
    recipientId: recipient.id,
    name: recipient.name,
    email: recipient.email,
    role: recipient.role,
    order: recipient.order,
    url: `/sign/${recipient.token}`,
  }));
}
