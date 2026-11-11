/**
 * Unit tests for the signing domain.
 *
 * They run against an in-memory database, so no state is written to disk and
 * the suite stays fast and deterministic.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { SignatureService, DomainError } from '../src/service.js';
import { verifyAuditChain } from '../src/pdf.js';
import type { CreateEnvelopeInput } from '@signatureit/shared';

/** Builds a minimal two-page PDF used as the document under signature. */
async function makePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 1; index <= 2; index += 1) {
    const page = pdf.addPage([595.28, 841.89]);
    page.drawText(`Page ${index} - DEPARTIFY contract`, { x: 60, y: 760, size: 18, font });
  }
  return Buffer.from(await pdf.save());
}

/** A 1x1 transparent PNG, used as the drawn signature. */
const SIGNATURE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function newService(): { service: SignatureService; store: Store } {
  const store = new Store(':memory:');
  const service = new SignatureService(store, '/tmp/signatureit-test');
  return { service, store };
}

function baseInput(pdf: Buffer): CreateEnvelopeInput {
  return {
    title: 'Contrato marco',
    documentBase64: pdf.toString('base64'),
    fileName: 'contrato.pdf',
    signatureLevel: 'simple',
    signingOrder: 'sequential',
    recipients: [
      { name: 'Ana Ruiz', email: 'ana@example.com', role: 'signer', order: 1, ref: 'r1' },
    ],
    fields: [
      {
        id: 'sig1',
        type: 'signature',
        required: true,
        recipientRef: 'r1',
        placement: { page: 1, x: 80, y: 700, width: 180, height: 60 },
      },
    ],
  };
}

describe('signature service', () => {
  test('creates a draft envelope with recipients and fields', async () => {
    const { service } = newService();
    const pdf = await makePdf();
    const envelope = await service.createEnvelope(baseInput(pdf));

    assert.equal(envelope.status, 'draft');
    assert.equal(envelope.title, 'Contrato marco');
    assert.equal(envelope.pageCount, 2);
    assert.equal(envelope.recipients.length, 1);
    assert.equal(envelope.fields.length, 1);
    assert.ok(envelope.audit.some((event) => event.type === 'envelope.created'));
  });

  test('rejects documents that are not PDFs', async () => {
    const { service } = newService();
    const input = baseInput(Buffer.from('not a pdf'));
    await assert.rejects(() => service.createEnvelope(input), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, 'unsupported_document');
      return true;
    });
  });

  test('requires at least one signer', async () => {
    const { service } = newService();
    const pdf = await makePdf();
    const input = baseInput(pdf);
    input.recipients = [{ name: 'Solo copia', email: 'copy@example.com', role: 'cc', order: 1 }];
    await assert.rejects(() => service.createEnvelope(input), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, 'no_signers');
      return true;
    });
  });

  test('signing produces a completed envelope and a signed PDF', async () => {
    const { service } = newService();
    const pdf = await makePdf();
    const envelope = await service.createEnvelope(baseInput(pdf));
    service.sendEnvelope(envelope.id);

    const recipient = service.getEnvelopeDetail(envelope.id)!.recipients[0];
    const signed = await service.sign(
      recipient.token,
      { values: {}, signatureImage: SIGNATURE_PNG, consentAccepted: true },
      { ip: '127.0.0.1', userAgent: 'test-suite' },
    );

    assert.equal(signed.status, 'completed');
    assert.ok(signed.completedAt);
    assert.equal(signed.recipients[0].status, 'signed');

    const signedPdf = service.getSignedDocument(envelope.id);
    assert.ok(signedPdf, 'the signed PDF must exist');
    assert.equal(signedPdf.content.subarray(0, 5).toString(), '%PDF-');
    // The original had two pages; the certificate adds a third.
    assert.ok(signedPdf.content.byteLength > pdf.byteLength);
  });

  test('requires consent before signing', async () => {
    const { service } = newService();
    const pdf = await makePdf();
    const envelope = await service.createEnvelope(baseInput(pdf));
    service.sendEnvelope(envelope.id);
    const recipient = service.getEnvelopeDetail(envelope.id)!.recipients[0];

    await assert.rejects(
      () => service.sign(recipient.token, { values: {}, signatureImage: SIGNATURE_PNG, consentAccepted: false }),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, 'consent_required');
        return true;
      },
    );
  });

  test('sequential signing enforces the turn order', async () => {
    const { service } = newService();
    const pdf = await makePdf();
    const input = baseInput(pdf);
    input.recipients.push({
      name: 'Luis Díaz',
      email: 'luis@example.com',
      role: 'signer',
      order: 2,
      ref: 'r2',
    });
    const envelope = await service.createEnvelope(input);
    service.sendEnvelope(envelope.id);

    const recipients = service.getEnvelopeDetail(envelope.id)!.recipients;
    const second = recipients.find((r) => r.email === 'luis@example.com')!;

    await assert.rejects(
      () => service.sign(second.token, { values: {}, signatureImage: SIGNATURE_PNG, consentAccepted: true }),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, 'not_your_turn');
        return true;
      },
    );
  });

  test('OTP envelopes verify the code before signing', async () => {
    const { service } = newService();
    const pdf = await makePdf();
    const input = baseInput(pdf);
    input.signatureLevel = 'simple_otp';
    const envelope = await service.createEnvelope(input);
    service.sendEnvelope(envelope.id);
    const recipient = service.getEnvelopeDetail(envelope.id)!.recipients[0];

    await assert.rejects(
      () => service.sign(recipient.token, { values: {}, signatureImage: SIGNATURE_PNG, consentAccepted: true }),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, 'otp_required');
        return true;
      },
    );

    const issued = service.requestOtp(recipient.token);
    assert.ok(issued.code);
    service.verifyOtp(recipient.token, issued.code!);

    const signed = await service.sign(recipient.token, {
      values: {},
      signatureImage: SIGNATURE_PNG,
      otp: issued.code,
      consentAccepted: true,
    });
    assert.equal(signed.status, 'completed');
  });

  test('the audit chain detects tampering', async () => {
    const { service, store } = newService();
    const pdf = await makePdf();
    const envelope = await service.createEnvelope(baseInput(pdf));
    service.sendEnvelope(envelope.id);
    const recipient = service.getEnvelopeDetail(envelope.id)!.recipients[0];
    await service.sign(recipient.token, { values: {}, signatureImage: SIGNATURE_PNG, consentAccepted: true });

    const events = store.listAuditEvents(envelope.id);
    assert.equal(verifyAuditChain(events).valid, true);

    const tampered = events.map((event, index) =>
      index === 1 ? { ...event, detail: { tampered: true } } : event,
    );
    const result = verifyAuditChain(tampered);
    assert.equal(result.valid, false);
    assert.equal(result.brokenAt, events[1].id);
  });

  test('the signing room only exposes the recipient own fields', async () => {
    const { service } = newService();
    const pdf = await makePdf();
    const input = baseInput(pdf);
    input.recipients.push({
      name: 'Luis Díaz',
      email: 'luis@example.com',
      role: 'signer',
      order: 2,
      ref: 'r2',
    });
    input.fields.push({
      id: 'sig2',
      type: 'signature',
      required: true,
      recipientRef: 'r2',
      placement: { page: 2, x: 80, y: 700, width: 180, height: 60 },
    });
    const envelope = await service.createEnvelope(input);
    service.sendEnvelope(envelope.id);

    const recipients = service.getEnvelopeDetail(envelope.id)!.recipients;
    const first = recipients.find((r) => r.email === 'ana@example.com')!;
    const room = service.getSigningRoom(first.token);
    assert.equal(room.fields.length, 1);
    assert.equal(room.recipient.email, 'ana@example.com');
    assert.equal(room.requiresOtp, false);
  });

  test('two stores on the same file do not fail with a locked database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'signatureit-lock-'));
    const dbPath = join(dir, 'shared.db');
    const pdf = await makePdf();

    try {
      // Two independent connections to the same file, like two server
      // processes sharing one database.
      const first = new Store(dbPath);
      const second = new Store(dbPath);
      const serviceA = new SignatureService(first, dir);
      const serviceB = new SignatureService(second, dir);

      const results = await Promise.all([
        serviceA.createEnvelope(baseInput(pdf)),
        serviceB.createEnvelope(baseInput(pdf)),
      ]);

      assert.equal(results.length, 2);
      for (const envelope of results) {
        assert.equal(envelope.recipients.length, 1);
        assert.equal(envelope.fields.length, 1);
        // The envelope is complete, not a half-written row.
        assert.ok(envelope.audit.length >= 1);
      }

      first.close();
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
