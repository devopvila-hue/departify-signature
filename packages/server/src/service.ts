/**
 * Domain service: the business rules that turn raw API payloads into signed,
 * auditable signature requests.
 *
 * The service is intentionally transport-agnostic so it can be reused by the
 * HTTP API, a future CLI, or a DEPARTIFY MCP tool without changes.
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_CONSENT_TEXT,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_PAGES,
  type CreateEnvelopeInput,
  type EnvelopeDetail,
  type EnvelopeSummary,
  type RecipientRecord,
  type SigningRoomPayload,
  type SignRequest,
} from '@signatureit/shared';
import { Store, type ActorContext } from './store.js';
import { buildSignedPdf, countPdfPages, verifyAuditChain } from './pdf.js';

/** Raised for expected, user-facing failures. */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'invalid_request',
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

const OTP_TTL_MS = 10 * 60 * 1000;

export class SignatureService {
  constructor(
    private readonly store: Store,
    private readonly storageDir: string,
  ) {
    mkdirSync(join(storageDir, 'signed'), { recursive: true });
  }

  /* ------------------------------- envelopes ------------------------------ */

  /** Creates a draft envelope from a base64 encoded PDF. */
  async createEnvelope(input: CreateEnvelopeInput, context?: ActorContext): Promise<EnvelopeDetail> {
    const bytes = Buffer.from(input.documentBase64, 'base64');
    if (bytes.byteLength === 0) throw new DomainError('The document is empty.', 400, 'empty_document');
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new DomainError('The document exceeds the 15 MB limit.', 413, 'document_too_large');
    }
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new DomainError('Only PDF documents can be signed.', 415, 'unsupported_document');
    }

    let pageCount: number;
    try {
      pageCount = await countPdfPages(bytes);
    } catch {
      throw new DomainError('The PDF could not be parsed.', 422, 'corrupt_document');
    }
    if (pageCount > MAX_DOCUMENT_PAGES) {
      throw new DomainError(`A document may contain at most ${MAX_DOCUMENT_PAGES} pages.`, 422, 'too_many_pages');
    }

    const fileName = input.fileName?.trim() || 'document.pdf';

    const signers = input.recipients.filter((r) => r.role === 'signer');
    const carbonCopies = input.recipients.filter((r) => r.role === 'cc');
    if (signers.length === 0) {
      throw new DomainError('At least one recipient with the signer role is required.', 400, 'no_signers');
    }

    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : undefined;

    // The whole creation is a single transaction: a half-written envelope
    // would leave orphan recipients or fields behind.
    const created = this.store.transaction(() => {
      const document = this.store.createDocument({ fileName, content: bytes, pageCount });

      const envelope = this.store.createEnvelope({
        title: input.title,
        fileName,
        message: input.message,
        signatureLevel: input.signatureLevel,
        signingOrder: input.signingOrder,
        documentId: document.id,
        documentSha256: document.sha256,
        pageCount,
        expiresAt,
        metadata: input.metadata,
      });

      const recipients: RecipientRecord[] = [];
      const recipientIdByRef = new Map<string, string>();
      for (const recipient of [...signers, ...carbonCopies]) {
        const record = this.store.createRecipient({
          envelopeId: envelope.id,
          name: recipient.name,
          email: recipient.email,
          role: recipient.role,
          order: recipient.order,
          message: recipient.message,
        });
        recipients.push(record);
        if (recipient.ref) recipientIdByRef.set(recipient.ref, record.id);
      }

      for (const field of input.fields) {
        const recipientId = field.recipientRef
          ? recipientIdByRef.get(field.recipientRef)
          : undefined;
        if (field.recipientRef && !recipientId) {
          throw new DomainError(`Unknown recipient for field ${field.id}.`, 400, 'unknown_recipient');
        }
        if (field.placement.page > pageCount) {
          throw new DomainError(`Field ${field.id} points to a page outside the document.`, 400, 'field_out_of_page');
        }
        this.store.createField({
          id: `${envelope.id}_${field.id}`,
          envelopeId: envelope.id,
          recipientId,
          type: field.type,
          label: field.label,
          required: field.required,
          page: field.placement.page,
          x: field.placement.x,
          y: field.placement.y,
          width: field.placement.width,
          height: field.placement.height,
          options: field.options,
          placeholder: field.placeholder,
        });
      }

      this.store.appendAuditEvent({
        envelopeId: envelope.id,
        type: 'envelope.created',
        actor: 'sender',
        detail: {
          title: input.title,
          recipients: recipients.length,
          fields: input.fields.length,
          signatureLevel: input.signatureLevel,
          documentSha256: document.sha256,
        },
        context,
      });

      return { envelope, recipients };
    });

    return this.getEnvelopeDetail(created.envelope.id)!;
  }

  /** Returns an envelope with recipients, fields and audit trail. */
  getEnvelopeDetail(envelopeId: string): EnvelopeDetail | undefined {
    const envelope = this.store.getEnvelope(envelopeId);
    if (!envelope) return undefined;
    const signedPath = join(this.storageDir, 'signed', `${envelopeId}.pdf`);
    return {
      ...envelope,
      recipients: this.store.listRecipients(envelopeId),
      fields: this.store.listFields(envelopeId),
      audit: this.store.listAuditEvents(envelopeId),
      signedDocumentPath: existsSync(signedPath) ? `/api/envelopes/${envelopeId}/signed` : undefined,
    };
  }

  /** Lists envelopes with recipient progress for the dashboard. */
  listEnvelopes(): EnvelopeSummary[] {
    return this.store.listEnvelopes().map((envelope) => {
      const recipients = this.store.listRecipients(envelope.id).filter((r) => r.role === 'signer');
      return {
        id: envelope.id,
        title: envelope.title,
        fileName: envelope.fileName,
        status: envelope.status,
        signatureLevel: envelope.signatureLevel,
        signingOrder: envelope.signingOrder,
        createdAt: envelope.createdAt,
        updatedAt: envelope.updatedAt,
        completedAt: envelope.completedAt,
        expiresAt: envelope.expiresAt,
        totalRecipients: recipients.length,
        signedRecipients: recipients.filter((r) => r.status === 'signed').length,
      };
    });
  }

  /** Moves a draft envelope to `sent` and opens it for the recipients. */
  sendEnvelope(envelopeId: string, context?: ActorContext): EnvelopeDetail {
    const envelope = this.store.getEnvelope(envelopeId);
    if (!envelope) throw new DomainError('Signature request not found.', 404, 'not_found');
    if (envelope.status !== 'draft') {
      throw new DomainError('Only draft requests can be sent.', 409, 'invalid_state');
    }
    const recipients = this.store.listRecipients(envelopeId);
    if (recipients.length === 0) throw new DomainError('Add at least one recipient.', 400, 'no_recipients');

    this.store.transaction(() => {
      this.store.updateEnvelopeStatus(envelopeId, 'sent');
      this.store.appendAuditEvent({
        envelopeId,
        type: 'envelope.sent',
        actor: 'sender',
        detail: { recipients: recipients.length, signingOrder: envelope.signingOrder },
        context,
      });

      for (const recipient of recipients) {
        if (recipient.role === 'signer' && envelope.signatureLevel === 'simple_otp') {
          this.issueOtp(envelopeId, recipient.id);
        }
      }
    });
    return this.getEnvelopeDetail(envelopeId)!;
  }

  /** Records a reminder action in the audit trail. */
  remindEnvelope(envelopeId: string, context?: ActorContext): EnvelopeDetail {
    const envelope = this.store.getEnvelope(envelopeId);
    if (!envelope) throw new DomainError('Signature request not found.', 404, 'not_found');
    if (envelope.status !== 'sent' && envelope.status !== 'partially_signed') {
      throw new DomainError('Only pending requests can be reminded.', 409, 'invalid_state');
    }
    this.store.appendAuditEvent({
      envelopeId,
      type: 'envelope.reminded',
      actor: 'sender',
      context,
    });
    return this.getEnvelopeDetail(envelopeId)!;
  }

  /** Cancels a request that has not been completed. */
  cancelEnvelope(envelopeId: string, context?: ActorContext): EnvelopeDetail {
    const envelope = this.store.getEnvelope(envelopeId);
    if (!envelope) throw new DomainError('Signature request not found.', 404, 'not_found');
    if (envelope.status === 'completed') {
      throw new DomainError('A completed request cannot be cancelled.', 409, 'invalid_state');
    }
    this.store.updateEnvelopeStatus(envelopeId, 'cancelled');
    this.store.appendAuditEvent({
      envelopeId,
      type: 'envelope.cancelled',
      actor: 'sender',
      context,
    });
    return this.getEnvelopeDetail(envelopeId)!;
  }

  /** Returns the original document bytes of an envelope. */
  getEnvelopeDocument(envelopeId: string): { content: Buffer; fileName: string } | undefined {
    const envelope = this.store.getEnvelope(envelopeId);
    if (!envelope) return undefined;
    const document = this.store.getDocumentBySha256(envelope.documentSha256);
    if (!document) return undefined;
    return this.store.getDocumentContent(document.id);
  }

  /* ------------------------------- signing room --------------------------- */

  /** Builds the payload handed to a signer, scoped to their own fields. */
  getSigningRoom(token: string, context?: ActorContext): SigningRoomPayload {
    const recipient = this.store.getRecipientByToken(token);
    if (!recipient) throw new DomainError('This signing link is not valid.', 404, 'invalid_token');
    const envelope = this.store.getEnvelope(recipient.envelopeId);
    if (!envelope) throw new DomainError('Signature request not found.', 404, 'not_found');

    this.assertNotExpired(envelope.expiresAt);

    if (recipient.status === 'pending') {
      this.store.markRecipientViewed(recipient.id);
      this.store.appendAuditEvent({
        envelopeId: envelope.id,
        type: 'recipient.viewed',
        actor: recipient.email,
        context,
      });
      this.store.appendAuditEvent({
        envelopeId: envelope.id,
        type: 'envelope.viewed',
        actor: recipient.email,
        context,
      });
    }

    const allFields = this.store.listFields(envelope.id);
    const fields = allFields
      .filter((field) => !field.recipientId || field.recipientId === recipient.id)
      .map((field) => ({
        id: field.id,
        type: field.type,
        label: field.label,
        required: field.required,
        page: field.page,
        x: field.x,
        y: field.y,
        width: field.width,
        height: field.height,
        options: field.options,
        placeholder: field.placeholder,
        value: field.value,
      }));

    return {
      envelopeId: envelope.id,
      title: envelope.title,
      message: envelope.message,
      signatureLevel: envelope.signatureLevel,
      fileName: envelope.fileName,
      pageCount: envelope.pageCount,
      documentUrl: `/api/signing/${token}/document`,
      recipient: {
        name: recipient.name,
        email: recipient.email,
        role: recipient.role,
        order: recipient.order,
        message: recipient.message,
        status: recipient.status,
      },
      fields,
      requiresOtp: envelope.signatureLevel === 'simple_otp' && recipient.role === 'signer',
      status: envelope.status,
      expiresAt: envelope.expiresAt,
      consentText: DEFAULT_CONSENT_TEXT,
    };
  }

  /** Returns the document bytes as seen by the signer. */
  getSigningDocument(token: string): { content: Buffer; fileName: string } {
    const recipient = this.store.getRecipientByToken(token);
    if (!recipient) throw new DomainError('This signing link is not valid.', 404, 'invalid_token');
    const envelope = this.store.getEnvelope(recipient.envelopeId);
    if (!envelope) throw new DomainError('Signature request not found.', 404, 'not_found');
    const document = this.store.getDocumentBySha256(envelope.documentSha256);
    if (!document) throw new DomainError('The document is no longer available.', 404, 'not_found');
    return this.store.getDocumentContent(document.id)!;
  }

  /** Issues a fresh OTP for a recipient and returns the code (local mode). */
  issueOtp(envelopeId: string, recipientId: string): string {
    const code = String(randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
    this.store.setRecipientOtp(recipientId, hashOtp(code), expiresAt);
    void envelopeId;
    return code;
  }

  /** Issues an OTP on demand for the signing room. */
  requestOtp(token: string, context?: ActorContext): { sent: boolean; code?: string; expiresAt?: string } {
    const recipient = this.store.getRecipientByToken(token);
    if (!recipient) throw new DomainError('This signing link is not valid.', 404, 'invalid_token');
    const envelope = this.store.getEnvelope(recipient.envelopeId)!;
    const code = this.issueOtp(envelope.id, recipient.id);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
    this.store.appendAuditEvent({
      envelopeId: envelope.id,
      type: 'recipient.verified',
      actor: recipient.email,
      detail: { action: 'otp_requested' },
      context,
    });
    // In a self-hosted deployment the code is delivered by SMS/email. Locally it
    // is returned so the flow can be exercised without an external provider.
    return { sent: true, code, expiresAt };
  }

  /** Checks an OTP code against the stored hash. */
  verifyOtp(token: string, code: string, context?: ActorContext): { verified: boolean } {
    const recipient = this.store.getRecipientByToken(token);
    if (!recipient) throw new DomainError('This signing link is not valid.', 404, 'invalid_token');
    if (!recipient.otpHash || !recipient.otpExpiresAt) {
      throw new DomainError('Request a verification code first.', 400, 'otp_not_requested');
    }
    if (new Date(recipient.otpExpiresAt).getTime() < Date.now()) {
      this.store.clearRecipientOtp(recipient.id);
      throw new DomainError('The verification code has expired.', 410, 'otp_expired');
    }
    const provided = Buffer.from(hashOtp(code));
    const expected = Buffer.from(recipient.otpHash);
    const ok = provided.length === expected.length && timingSafeEqual(provided, expected);
    if (!ok) throw new DomainError('The verification code is not correct.', 400, 'otp_invalid');
    this.store.appendAuditEvent({
      envelopeId: recipient.envelopeId,
      type: 'recipient.verified',
      actor: recipient.email,
      detail: { action: 'otp_verified' },
      context,
    });
    return { verified: true };
  }

  /**
   * Applies a signature. Validates required fields, consent and the OTP when
   * the envelope demands one, then generates the signed PDF.
   */
  async sign(token: string, request: SignRequest, context?: ActorContext): Promise<EnvelopeDetail> {
    const recipient = this.store.getRecipientByToken(token);
    if (!recipient) throw new DomainError('This signing link is not valid.', 404, 'invalid_token');
    if (recipient.status === 'signed') {
      throw new DomainError('This document has already been signed.', 409, 'already_signed');
    }
    if (recipient.role === 'cc') {
      throw new DomainError('Copy recipients cannot sign.', 400, 'not_a_signer');
    }

    const envelope = this.store.getEnvelope(recipient.envelopeId);
    if (!envelope) throw new DomainError('Signature request not found.', 404, 'not_found');
    this.assertNotExpired(envelope.expiresAt);
    this.assertSigningTurn(envelope, recipient);

    if (!request.consentAccepted) {
      throw new DomainError('The consent must be accepted before signing.', 400, 'consent_required');
    }

    if (envelope.signatureLevel === 'simple_otp') {
      if (!recipient.otpHash) {
        throw new DomainError('Request a verification code before signing.', 400, 'otp_required');
      }
      if (!request.otp) throw new DomainError('The verification code is required.', 400, 'otp_required');
      const provided = Buffer.from(hashOtp(request.otp));
      const expected = Buffer.from(recipient.otpHash);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        throw new DomainError('The verification code is not correct.', 400, 'otp_invalid');
      }
    }

    const fields = this.store.listFields(envelope.id);
    const mine = fields.filter((field) => !field.recipientId || field.recipientId === recipient.id);

    // Persisting the signature is atomic: field values, the recipient status
    // and the audit events either all land or none of them do.
    const signedAt = new Date().toISOString();
    const applied = this.store.transaction(() => {
      for (const [fieldId, value] of Object.entries(request.values)) {
        const field = fields.find((candidate) => candidate.id === fieldId);
        if (!field) continue;
        if (field.recipientId && field.recipientId !== recipient.id) {
          throw new DomainError(
            'A field belonging to another recipient cannot be modified.',
            403,
            'field_forbidden',
          );
        }
        const normalized = typeof value === 'boolean' ? String(value) : value;
        this.store.setFieldValue(field.id, normalized);
        this.store.appendAuditEvent({
          envelopeId: envelope.id,
          type: 'field.completed',
          actor: recipient.email,
          detail: { fieldId: field.id, fieldType: field.type },
          context,
        });
      }

      // The drawn signature applies to every signature field owned by this recipient.
      if (request.signatureImage) {
        const signatureFields = mine.filter(
          (field) => (field.type === 'signature' || field.type === 'initials') && !field.value,
        );
        for (const field of signatureFields) {
          this.store.setFieldValue(field.id, request.signatureImage);
        }
      }

      // Required fields are validated once every collected value is stored.
      const stillMissing = this.store
        .listFields(envelope.id)
        .filter((field) => !field.recipientId || field.recipientId === recipient.id)
        .filter((field) => field.required && !field.value);
      if (stillMissing.length > 0) {
        const labels = stillMissing.map((field) => field.label ?? field.type).join(', ');
        throw new DomainError(`Faltan campos obligatorios: ${labels}.`, 400, 'required_field_missing');
      }

      this.store.updateRecipientStatus(recipient.id, 'signed', signedAt);
      this.store.appendAuditEvent({
        envelopeId: envelope.id,
        type: 'recipient.signed',
        actor: recipient.email,
        detail: { name: recipient.name, signedAt },
        context,
      });
      this.store.clearRecipientOtp(recipient.id);

      const recipients = this.store.listRecipients(envelope.id);
      const signers = recipients.filter((r) => r.role === 'signer');
      return { allSigned: signers.every((r) => r.status === 'signed') };
    });

    if (applied.allSigned) {
      await this.finalizeEnvelope(envelope.id, context);
    } else {
      this.store.updateEnvelopeStatus(envelope.id, 'partially_signed');
    }

    return this.getEnvelopeDetail(envelope.id)!;
  }

  /** Registers a refusal from a recipient. */
  decline(token: string, reason: string, context?: ActorContext): EnvelopeDetail {
    const recipient = this.store.getRecipientByToken(token);
    if (!recipient) throw new DomainError('This signing link is not valid.', 404, 'invalid_token');
    const envelope = this.store.getEnvelope(recipient.envelopeId)!;
    this.store.transaction(() => {
      this.store.updateRecipientStatus(recipient.id, 'declined');
      this.store.appendAuditEvent({
        envelopeId: envelope.id,
        type: 'recipient.declined',
        actor: recipient.email,
        detail: { reason },
        context,
      });
      this.store.appendAuditEvent({
        envelopeId: envelope.id,
        type: 'envelope.declined',
        actor: recipient.email,
        detail: { reason },
        context,
      });
      this.store.updateEnvelopeStatus(envelope.id, 'declined');
    });
    return this.getEnvelopeDetail(envelope.id)!;
  }

  /** Generates the final signed PDF and closes the request. */
  private async finalizeEnvelope(envelopeId: string, context?: ActorContext): Promise<void> {
    const envelope = this.store.getEnvelope(envelopeId)!;
    const document = this.store.getDocumentBySha256(envelope.documentSha256);
    if (!document) throw new DomainError('The document is no longer available.', 500, 'document_missing');
    const original = this.store.getDocumentContent(document.id)!.content;

    const recipients = this.store.listRecipients(envelopeId);
    const fields = this.store.listFields(envelopeId);
    const signedAt = new Date().toISOString();

    const result = await buildSignedPdf({
      original,
      fields,
      recipients,
      audit: this.store.listAuditEvents(envelopeId),
      envelopeTitle: envelope.title,
      envelopeId,
      signatureLevel: envelope.signatureLevel,
      signedAt,
    });

    const target = join(this.storageDir, 'signed', `${envelopeId}.pdf`);
    writeFileSync(target, result.bytes);

    this.store.appendAuditEvent({
      envelopeId,
      type: 'envelope.completed',
      actor: 'system',
      detail: {
        signedDocumentSha256: result.sha256,
        originalDocumentSha256: envelope.documentSha256,
        pages: result.pageCount,
      },
      context,
    });
    this.store.updateEnvelopeStatus(envelopeId, 'completed', signedAt);
  }

  /** Returns the bytes of the final signed PDF. */
  getSignedDocument(envelopeId: string): { content: Buffer; fileName: string } | undefined {
    const envelope = this.store.getEnvelope(envelopeId);
    if (!envelope) return undefined;
    const path = join(this.storageDir, 'signed', `${envelopeId}.pdf`);
    if (!existsSync(path)) return undefined;
    return {
      content: readFileSync(path),
      fileName: `${envelope.title.replace(/[^\w.-]+/g, '_')}-signed.pdf`,
    };
  }

  /** Verifies the integrity of the audit chain. */
  verifyAudit(envelopeId: string) {
    const events = this.store.listAuditEvents(envelopeId);
    return verifyAuditChain(events);
  }

  /* -------------------------------- helpers ------------------------------- */

  private assertNotExpired(expiresAt?: string): void {
    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
      throw new DomainError('This signature request has expired.', 410, 'expired');
    }
  }

  /**
   * With sequential signing, only the first pending signer may act. Once a
   * signer completes, the next one in sequence is unlocked.
   */
  private assertSigningTurn(envelope: { signingOrder: string; id: string }, recipient: RecipientRecord): void {
    if (envelope.signingOrder !== 'sequential') return;
    const signers = this.store
      .listRecipients(envelope.id)
      .filter((r) => r.role === 'signer')
      .sort((a, b) => a.order - b.order);
    const next = signers.find((r) => r.status !== 'signed' && r.status !== 'declined');
    if (next && next.id !== recipient.id) {
      throw new DomainError('It is not your turn to sign yet.', 409, 'not_your_turn');
    }
  }
}

function hashOtp(code: string): string {
  return createHash('sha256').update(`otp:${code}`).digest('hex');
}
