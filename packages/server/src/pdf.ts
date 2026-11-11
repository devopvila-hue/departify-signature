/**
 * PDF engine: renders the document to be signed and produces the final signed
 * PDF with an embedded audit certificate.
 *
 * Implemented with `pdf-lib`, which runs entirely in-process: no external
 * conversion service, no headless browser and no network access.
 */
import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage } from 'pdf-lib';
import { createHash } from 'node:crypto';
import type { AuditEventRecord, FieldRecord, RecipientRecord } from '@signatureit/shared';
import { canonicalJson } from './store.js';

/** Result of stamping a document with the collected signatures. */
export interface SignedPdfResult {
  bytes: Buffer;
  sha256: string;
  pageCount: number;
}

/** Reads the page count of a PDF without modifying it. */
export async function countPdfPages(bytes: Buffer): Promise<number> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getPageCount();
}

/** Decodes a `data:image/png;base64,...` payload or a raw base64 PNG. */
export function decodeImagePayload(payload: string): Buffer {
  const commaIndex = payload.indexOf(',');
  const base64 = payload.startsWith('data:') && commaIndex >= 0 ? payload.slice(commaIndex + 1) : payload;
  return Buffer.from(base64, 'base64');
}

/**
 * Converts a PDF point coordinate (origin top-left, as used by the editor and
 * the browser) into the PDF user-space coordinate (origin bottom-left).
 */
function toPdfCoordinates(
  page: PDFPage,
  field: Pick<FieldRecord, 'x' | 'y' | 'width' | 'height'>,
): { x: number; y: number } {
  const { height: pageHeight } = page.getSize();
  return {
    x: field.x,
    y: pageHeight - field.y - field.height,
  };
}

/** Draws a checkbox tick or an X mark inside the field box. */
function drawCheckbox(page: PDFPage, field: FieldRecord, font: PDFFont, color = rgb(0.05, 0.45, 0.3)) {
  const { x, y } = toPdfCoordinates(page, field);
  const size = Math.min(field.width, field.height) * 0.42;
  const offsetX = (field.width - size) / 2;
  const offsetY = (field.height - size) / 2;
  page.drawRectangle({
    x: x + offsetX,
    y: y + offsetY,
    width: size,
    height: size,
    borderColor: color,
    borderWidth: 1.6,
    opacity: 0,
  });
  page.drawText('X', {
    x: x + offsetX,
    y: y + offsetY - size * 0.18,
    size,
    font,
    color,
  });
}

/**
 * Applies the collected field values and signatures to the original document
 * and appends a certificate page describing the evidence.
 */
export async function buildSignedPdf(params: {
  original: Buffer;
  fields: FieldRecord[];
  recipients: RecipientRecord[];
  audit: AuditEventRecord[];
  envelopeTitle: string;
  envelopeId: string;
  signatureLevel: string;
  signedAt: string;
}): Promise<SignedPdfResult> {
  const pdf = await PDFDocument.load(params.original, { ignoreEncryption: true });
  const standardFont = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

  const recipientById = new Map(params.recipients.map((r) => [r.id, r]));

  for (const field of params.fields) {
    if (!field.value) continue;
    const page = pdf.getPage(field.page - 1);
    if (!page) continue;

    if (field.type === 'signature' || field.type === 'initials') {
      const imageBytes = decodeImagePayload(field.value);
      let image;
      try {
        image = await pdf.embedPng(imageBytes);
      } catch {
        image = await pdf.embedJpg(imageBytes);
      }
      const { x, y } = toPdfCoordinates(page, field);
      // Preserve the aspect ratio of the drawn signature inside the box.
      const scale = Math.min(field.width / image.width, field.height / image.height);
      const drawWidth = image.width * scale;
      const drawHeight = image.height * scale;
      page.drawImage(image, {
        x: x + (field.width - drawWidth) / 2,
        y: y + (field.height - drawHeight) / 2,
        width: drawWidth,
        height: drawHeight,
      });
      continue;
    }

    if (field.type === 'checkbox') {
      if (field.value === 'true') drawCheckbox(page, field, standardFont);
      continue;
    }

    if (field.type === 'dropdown') {
      const { x, y } = toPdfCoordinates(page, field);
      const size = Math.min(11, field.height * 0.55);
      page.drawText(field.value, {
        x,
        y: y + (field.height - size) / 2,
        size,
        font: standardFont,
        color: rgb(0.08, 0.09, 0.11),
      });
      continue;
    }

    // text and date
    const { x, y } = toPdfCoordinates(page, field);
    const size = Math.min(11, Math.max(7, field.height * 0.5));
    page.drawText(field.value, {
      x,
      y: y + (field.height - size) / 2,
      size,
      font: standardFont,
      color: rgb(0.08, 0.09, 0.11),
    });
  }

  await appendCertificatePage(pdf, {
    envelopeTitle: params.envelopeTitle,
    envelopeId: params.envelopeId,
    signatureLevel: params.signatureLevel,
    signedAt: params.signedAt,
    recipients: params.recipients,
    audit: params.audit,
    originalSha256: createHash('sha256').update(params.original).digest('hex'),
    regularFont: standardFont,
    boldFont,
  });

  const bytes = Buffer.from(await pdf.save());
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    pageCount: pdf.getPageCount(),
  };
}

interface CertificateParams {
  envelopeTitle: string;
  envelopeId: string;
  signatureLevel: string;
  signedAt: string;
  recipients: RecipientRecord[];
  audit: AuditEventRecord[];
  originalSha256: string;
  regularFont: PDFFont;
  boldFont: PDFFont;
}

/**
 * Appends a certificate page summarising the evidence: document hash, signers,
 * assurance level and the audit trail chain.
 */
async function appendCertificatePage(pdf: PDFDocument, params: CertificateParams): Promise<void> {
  const page = pdf.addPage([595.28, 841.89]); // A4
  const { width, height } = page.getSize();
  const margin = 48;
  let y = height - margin;

  const drawLine = (text: string, options: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
    const { size = 10, bold = false, color = rgb(0.2, 0.22, 0.25) } = options;
    page.drawText(text, {
      x: margin,
      y,
      size,
      font: bold ? params.boldFont : params.regularFont,
      color,
    });
    y -= size + 5;
  };

  page.drawRectangle({
    x: 0,
    y: height - 8,
    width,
    height: 8,
    color: rgb(0.55, 0.82, 0.15),
  });

  y -= 22;
  drawLine('Electronic signature certificate', { size: 17, bold: true, color: rgb(0.05, 0.1, 0.08) });
  y -= 4;
  drawLine(`Document: ${params.envelopeTitle}`, { size: 11, bold: true });
  drawLine(`Request id: ${params.envelopeId}`);
  drawLine(`Assurance level: ${params.signatureLevel}`);
  drawLine(`Signed at: ${params.signedAt}`);
  y -= 8;

  drawLine('Document integrity', { size: 12, bold: true, color: rgb(0.05, 0.1, 0.08) });
  drawLine(`SHA-256 (original): ${params.originalSha256}`, { size: 7.5 });
  y -= 8;

  drawLine('Signers', { size: 12, bold: true, color: rgb(0.05, 0.1, 0.08) });
  for (const recipient of params.recipients) {
    if (recipient.role !== 'signer') continue;
    const signedAt = recipient.signedAt ? new Date(recipient.signedAt).toISOString() : 'not signed';
    drawLine(`${recipient.name} <${recipient.email}> — ${signedAt}`, { size: 9 });
  }
  y -= 8;

  drawLine('Audit trail', { size: 12, bold: true, color: rgb(0.05, 0.1, 0.08) });
  for (const event of params.audit) {
    const who = event.actor || 'system';
    drawLine(`${event.at} · ${event.type} · ${who}`, { size: 8 });
    y -= 1;
  }
  y -= 6;

  drawLine(`Chain head: ${params.audit.at(-1)?.hash ?? 'genesis'}`, { size: 7.5 });
  drawLine('This certificate is generated by DEPARTIFY Signature and can be verified against the audit trail.', {
    size: 7.5,
    color: rgb(0.45, 0.47, 0.5),
  });

  page.drawText('DEPARTIFY · Signature', {
    x: margin,
    y: margin - 6,
    size: 8,
    font: params.boldFont,
    color: rgb(0.55, 0.82, 0.15),
  });
}

/**
 * Recomputes the audit chain and reports the first event that does not match.
 */
export function verifyAuditChain(events: AuditEventRecord[]): {
  valid: boolean;
  checked: number;
  brokenAt?: string;
  reason?: string;
  headHash: string;
} {
  let prevHash = 'genesis';
  for (const event of events) {
    if (event.prevHash !== prevHash) {
      return {
        valid: false,
        checked: events.indexOf(event),
        brokenAt: event.id,
        reason: 'previous hash mismatch',
        headHash: prevHash,
      };
    }
    const expected = createHash('sha256')
      .update(
        canonicalJson({
          id: event.id,
          envelopeId: event.envelopeId,
          type: event.type,
          actor: event.actor,
          at: event.at,
          ip: event.ip ?? null,
          userAgent: event.userAgent ?? null,
          detail: event.detail ?? null,
          prevHash: event.prevHash,
        }),
      )
      .digest('hex');
    if (expected !== event.hash) {
      return {
        valid: false,
        checked: events.indexOf(event),
        brokenAt: event.id,
        reason: 'event hash mismatch',
        headHash: prevHash,
      };
    }
    prevHash = event.hash;
  }
  return {
    valid: true,
    checked: events.length,
    headHash: prevHash,
  };
}
