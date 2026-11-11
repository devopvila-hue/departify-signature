/**
 * End-to-end verification against a real HTTP server.
 *
 * Starts the API on an ephemeral port, walks the complete flow (create, send,
 * sign, download, verify the audit chain) and fails loudly on any broken step.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { SignatureService } from '../src/service.js';
import { buildServer } from '../src/routes.js';

const SIGNATURE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function makePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595.28, 841.89]);
  page.drawText('DEPARTIFY e-signature end-to-end', { x: 60, y: 760, size: 18, font });
  return Buffer.from(await pdf.save());
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'signatureit-e2e-'));
  const store = new Store(join(dataDir, 'e2e.db'));
  const service = new SignatureService(store, dataDir);
  const app = await buildServer({ store, service, logger: false });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind the test server');
  const base = `http://127.0.0.1:${address.port}`;
  console.log(`\nE2E contra ${base}\n`);

  try {
    /* ------------------------------- health ------------------------------ */
    const health = await fetch(`${base}/api/health`);
    const healthBody = (await health.json()) as { status: string };
    check('GET /api/health responde ok', health.status === 200 && healthBody.status === 'ok');

    /* ------------------------------ create ------------------------------- */
    const pdf = await makePdf();
    const created = await fetch(`${base}/api/envelopes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Contrato E2E',
        documentBase64: pdf.toString('base64'),
        fileName: 'e2e.pdf',
        message: 'Firma para validar el flujo completo.',
        signatureLevel: 'simple',
        signingOrder: 'sequential',
        recipients: [
          { name: 'Ana Ruiz', email: 'ana@example.com', role: 'signer', order: 1, ref: 'r1' },
          { name: 'Luis Díaz', email: 'luis@example.com', role: 'signer', order: 2, ref: 'r2' },
        ],
        fields: [
          {
            id: 'sig1',
            type: 'signature',
            required: true,
            recipientRef: 'r1',
            placement: { page: 1, x: 80, y: 700, width: 180, height: 60 },
          },
          {
            id: 'date1',
            type: 'date',
            label: 'Fecha de firma',
            required: true,
            recipientRef: 'r1',
            placement: { page: 1, x: 80, y: 650, width: 120, height: 28 },
          },
          {
            id: 'sig2',
            type: 'signature',
            required: true,
            recipientRef: 'r2',
            placement: { page: 1, x: 320, y: 700, width: 180, height: 60 },
          },
        ],
      }),
    });
    const createdBody = (await created.json()) as { envelope: { id: string; status: string } };
    check('POST /api/envelopes crea la solicitud', created.status === 201, createdBody.envelope?.id);
    const envelopeId = createdBody.envelope.id;

    /* -------------------------------- send -------------------------------- */
    const sent = await fetch(`${base}/api/envelopes/${envelopeId}/send`, { method: 'POST' });
    const sentBody = (await sent.json()) as {
      envelope: { status: string };
      links: Array<{ email: string; url: string; token?: string }>;
    };
    check('POST /send cambia el estado a enviado', sentBody.envelope.status === 'sent');
    check('El envío genera un enlace por firmante', sentBody.links.length === 2);

    const tokens = new Map<string, string>();
    for (const link of sentBody.links) {
      tokens.set(link.email, link.url.split('/').pop()!);
    }

    /* ---------------------------- signing room ---------------------------- */
    const firstToken = tokens.get('ana@example.com')!;
    const roomResponse = await fetch(`${base}/api/signing/${firstToken}`);
    const roomBody = (await roomResponse.json()) as {
      room: { fields: unknown[]; title: string; requiresOtp: boolean };
    };
    check('GET /api/signing/:token devuelve la sala', roomResponse.status === 200, roomBody.room.title);
    check(
      'La sala solo expone los campos del firmante',
      roomBody.room.fields.length === 2,
      `${roomBody.room.fields.length} campos`,
    );

    const documentResponse = await fetch(`${base}/api/signing/${firstToken}/document`);
    const documentBuffer = Buffer.from(await documentResponse.arrayBuffer());
    check(
      'El firmante puede descargar el documento original',
      documentResponse.status === 200 && documentBuffer.subarray(0, 5).toString() === '%PDF-',
    );

    /* ------------------- sequential guard (second early) ------------------ */
    const secondToken = tokens.get('luis@example.com')!;
    const tooEarly = await fetch(`${base}/api/signing/${secondToken}/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        values: {},
        signatureImage: SIGNATURE_PNG,
        consentAccepted: true,
      }),
    });
    check(
      'La firma secuencial bloquea al segundo firmante',
      tooEarly.status === 409,
      `HTTP ${tooEarly.status}`,
    );

    /* --------------------------- sign (first) ----------------------------- */
    const dateFieldId = `${envelopeId}_date1`;
    const signFirst = await fetch(`${base}/api/signing/${firstToken}/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        values: { [dateFieldId]: '2026-11-11' },
        signatureImage: SIGNATURE_PNG,
        consentAccepted: true,
      }),
    });
    const signFirstBody = (await signFirst.json()) as { envelope: { status: string } };
    check(
      'El primer firmante firma y el estado queda parcial',
      signFirst.status === 200 && signFirstBody.envelope.status === 'partially_signed',
      signFirstBody.envelope?.status,
    );

    /* --------------------------- sign (second) ---------------------------- */
    const signSecond = await fetch(`${base}/api/signing/${secondToken}/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        values: {},
        signatureImage: SIGNATURE_PNG,
        consentAccepted: true,
      }),
    });
    const signSecondBody = (await signSecond.json()) as { envelope: { status: string } };
    check(
      'El segundo firmante completa el documento',
      signSecond.status === 200 && signSecondBody.envelope.status === 'completed',
      signSecondBody.envelope.status,
    );

    /* -------------------------- signed document --------------------------- */
    const signedResponse = await fetch(`${base}/api/envelopes/${envelopeId}/signed`);
    const signedBuffer = Buffer.from(await signedResponse.arrayBuffer());
    check(
      'El PDF firmado se descarga correctamente',
      signedResponse.status === 200 && signedBuffer.subarray(0, 5).toString() === '%PDF-',
      `${signedBuffer.byteLength} bytes`,
    );

    const signedPdf = await PDFDocument.load(signedBuffer);
    check(
      'El PDF firmado añade la página de certificado',
      signedPdf.getPageCount() === 2,
      `${signedPdf.getPageCount()} páginas`,
    );

    /* ------------------------------- audit -------------------------------- */
    const auditResponse = await fetch(`${base}/api/envelopes/${envelopeId}/audit`);
    const auditBody = (await auditResponse.json()) as {
      audit: Array<{ type: string }>;
      verification: { valid: boolean; checked: number };
    };
    check('El registro de auditoría está disponible', auditResponse.status === 200);
    check(
      'La cadena de auditoría verifica correctamente',
      auditBody.verification.valid && auditBody.verification.checked === auditBody.audit.length,
      `${auditBody.verification.checked} eventos`,
    );
    check(
      'Se registra la firma de cada firmante',
      auditBody.audit.filter((event) => event.type === 'recipient.signed').length === 2,
    );
    check(
      'Se registra la finalización del documento',
      auditBody.audit.some((event) => event.type === 'envelope.completed'),
    );

    /* ------------------------------- list --------------------------------- */
    const listResponse = await fetch(`${base}/api/envelopes`);
    const listBody = (await listResponse.json()) as { envelopes: Array<{ status: string }> };
    check(
      'El listado refleja el documento completado',
      listBody.envelopes.length === 1 && listBody.envelopes[0].status === 'completed',
    );

    /* ----------------------------- validation ----------------------------- */
    const invalid = await fetch(`${base}/api/envelopes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    check('La validación rechaza payloads inválidos', invalid.status === 400, `HTTP ${invalid.status}`);

    /* --------------------- bodyless POST compatibility -------------------- */
    // An integration script calling `curl -X POST` sends no JSON body and a
    // different content type; the API must accept it.
    const bodyless = await fetch(`${base}/api/envelopes/${envelopeId}/remind`, { method: 'POST' });
    check(
      'Un POST sin cuerpo JSON no devuelve 415',
      bodyless.status !== 415 && bodyless.status < 500,
      `HTTP ${bodyless.status}`,
    );

    const formEncoded = await fetch(`${base}/api/envelopes/${envelopeId}/remind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    check(
      'Un POST form-urlencoded no devuelve 415',
      formEncoded.status !== 415 && formEncoded.status < 500,
      `HTTP ${formEncoded.status}`,
    );
  } finally {
    await app.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }

  const failed = checks.filter((item) => !item.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} comprobaciones superadas`);
  if (failed.length > 0) {
    console.error('\nComprobaciones fallidas:');
    for (const item of failed) console.error(`  ✗ ${item.name} ${item.detail}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
