/**
 * Demo seed: creates realistic local data so the application can be explored
 * immediately, without uploading a PDF by hand.
 *
 * It produces three signature requests that cover the interesting states:
 *   1. a draft that has not been sent yet;
 *   2. a sent request with two signers in sequential order;
 *   3. a completed request with the full audit trail and a signed PDF.
 *
 * Usage: pnpm --filter @signatureit/server run seed
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { SignatureService } from '../src/service.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SIGNATUREIT_DATA_DIR ?? join(here, '..', 'data');

/* -------------------------------------------------------------------------- */
/* Minimal PNG encoder (no native canvas, no image dependency)                 */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encodes RGBA pixels as a PNG buffer. */
function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Distance from a point to a line segment. */
function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Draws a cursive-looking signature with a few strokes and returns a PNG.
 * It is deliberately simple: a transparent canvas with dark strokes.
 */
function drawSignature(): Buffer {
  const width = 520;
  const height = 170;
  const rgba = Buffer.alloc(width * height * 4);

  // A stylised signature: a capital letter followed by a flowing word.
  const strokes: Array<Array<[number, number]>> = [
    [
      [70, 120],
      [58, 78],
      [44, 52],
      [38, 66],
      [46, 96],
      [64, 108],
      [86, 74],
      [96, 44],
      [90, 24],
      [76, 34],
      [72, 66],
    ],
    [
      [96, 76],
      [120, 104],
      [140, 76],
      [150, 40],
      [144, 22],
      [130, 34],
      [126, 70],
      [142, 96],
      [166, 104],
    ],
    [
      [166, 104],
      [190, 96],
      [206, 66],
      [214, 40],
      [220, 58],
      [228, 88],
      [246, 96],
      [258, 74],
      [258, 46],
      [248, 30],
      [236, 42],
      [238, 72],
      [254, 94],
      [276, 92],
    ],
    [
      [276, 92],
      [296, 72],
      [306, 44],
      [300, 28],
      [288, 40],
      [290, 76],
      [308, 100],
      [336, 102],
    ],
    [
      [336, 102],
      [360, 92],
      [374, 62],
      [380, 38],
      [388, 58],
      [398, 86],
      [418, 92],
      [436, 68],
      [446, 46],
      [452, 70],
      [462, 88],
    ],
    [
      [60, 128],
      [150, 138],
      [260, 132],
      [380, 140],
      [470, 130],
    ],
  ];

  const radius = 3.1;
  for (const stroke of strokes) {
    for (let s = 0; s < stroke.length - 1; s += 1) {
      const [ax, ay] = stroke[s];
      const [bx, by] = stroke[s + 1];
      const minX = Math.max(0, Math.floor(Math.min(ax, bx) - radius - 1));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + radius + 1));
      const minY = Math.max(0, Math.floor(Math.min(ay, by) - radius - 1));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by) + radius + 1));
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          if (distanceToSegment(x + 0.5, y + 0.5, ax, ay, bx, by) <= radius) {
            const offset = (y * width + x) * 4;
            rgba[offset] = 20;
            rgba[offset + 1] = 25;
            rgba[offset + 2] = 30;
            rgba[offset + 3] = 255;
          }
        }
      }
    }
  }

  return encodePng(width, height, rgba);
}

/* -------------------------------------------------------------------------- */
/* Sample document                                                             */
/* -------------------------------------------------------------------------- */

/** Builds a two-page service agreement used as the document under signature. */
async function buildContract(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const green = rgb(0.09, 0.33, 0.18);

  const page1 = pdf.addPage([595.28, 841.89]);
  page1.drawRectangle({ x: 0, y: 790, width: 595.28, height: 52, color: green });
  page1.drawText('DEPARTIFY', { x: 48, y: 810, size: 18, font: bold, color: rgb(1, 1, 1) });
  page1.drawText('Acuerdo marco de servicios', { x: 48, y: 742, size: 22, font: bold });
  page1.drawText('Ref. DM-2026-0148', { x: 48, y: 718, size: 10, font: regular, color: rgb(0.4, 0.4, 0.4) });

  const clauses = [
    '1. Objeto del contrato',
    'El presente acuerdo regula las condiciones deprestacion de servicios entre las',
    'partes identificadas en el documento, con efectos desde la fecha de la ultima firma.',
    '',
    '2. Alcance de los servicios',
    'El contratista se obliga a prestar los servicios pactados con los niveles de calidad',
    'y los plazos recogidos en el documento de encargo que accompanies a este acuerdo.',
    '',
    '3. Confidencialidad',
    'Las partes se obligan a mantener confidencial toda la informacion a la que accedan',
    'con occasion del contrato, con independencia del soporte en que se encuentre.',
    '',
    '4. Proteccion de datos',
    'El tratamiento de datos personales se realizara conforme al RGPD y a la normativa',
    'aplicable, conservando las partes evidencia de las operaciones de firma realizadas.',
  ];
  let y = 680;
  for (const line of clauses) {
    const isHeading = /^\d\./.test(line);
    page1.drawText(line, { x: 48, y, size: isHeading ? 12 : 10.5, font: isHeading ? bold : regular });
    y -= isHeading ? 22 : 16;
  }

  page1.drawText('Firmas', { x: 48, y: 330, size: 14, font: bold });
  page1.drawText('Firmante 1', { x: 48, y: 300, size: 10, font: regular, color: rgb(0.4, 0.4, 0.4) });
  page1.drawLine({ start: { x: 48, y: 285 }, end: { x: 250, y: 285 }, thickness: 0.8 });
  page1.drawText('Fecha', { x: 48, y: 250, size: 10, font: regular, color: rgb(0.4, 0.4, 0.4) });
  page1.drawLine({ start: { x: 48, y: 235 }, end: { x: 180, y: 235 }, thickness: 0.8 });
  page1.drawText('Firmante 2', { x: 320, y: 300, size: 10, font: regular, color: rgb(0.4, 0.4, 0.4) });
  page1.drawLine({ start: { x: 320, y: 285 }, end: { x: 522, y: 285 }, thickness: 0.8 });
  page1.drawText('Fecha', { x: 320, y: 250, size: 10, font: regular, color: rgb(0.4, 0.4, 0.4) });
  page1.drawText('Página 1 de 2', { x: 470, y: 60, size: 9, font: regular, color: rgb(0.5, 0.5, 0.5) });

  const page2 = pdf.addPage([595.28, 841.89]);
  page2.drawText('5. Importes y forma de pago', { x: 48, y: 760, size: 14, font: bold });
  const rows = [
    ['Concepto', 'Periodicidad', 'Importe'],
    ['Servicio base', 'Mensual', '1.200,00 EUR'],
    ['Soporte prioritario', 'Mensual', '180,00 EUR'],
    ['Integracion CRM', 'Puntual', '900,00 EUR'],
  ];
  let rowY = 720;
  for (const [index, row] of rows.entries()) {
    for (const [column, cell] of row.entries()) {
      page2.drawText(cell, {
        x: 48 + column * 170,
        y: rowY,
        size: 10.5,
        font: index === 0 ? bold : regular,
      });
    }
    page2.drawLine({
      start: { x: 48, y: rowY - 10 },
      end: { x: 522, y: rowY - 10 },
      thickness: 0.6,
      color: rgb(0.85, 0.85, 0.85),
    });
    rowY -= 30;
  }
  page2.drawText('6. Resolucion', { x: 48, y: 560, size: 14, font: bold });
  page2.drawText('El incumplimiento de las obligaciones pactadas permitira resolver el', {
    x: 48,
    y: 530,
    size: 10.5,
    font: regular,
  });
  page2.drawText('acuerdo de forma unilateral, sin perjuicio de los danos y perjuicios', {
    x: 48,
    y: 514,
    size: 10.5,
    font: regular,
  });
  page2.drawText('causados que en su caso proceda.', { x: 48, y: 498, size: 10.5, font: regular });
  page2.drawText('Página 2 de 2', { x: 470, y: 60, size: 9, font: regular, color: rgb(0.5, 0.5, 0.5) });

  return Buffer.from(await pdf.save());
}

/* -------------------------------------------------------------------------- */
/* Seeding                                                                     */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const store = new Store(join(dataDir, 'signatureit.db'));
  const service = new SignatureService(store, dataDir);
  const contract = await buildContract();
  const signature = drawSignature();
  const signatureDataUrl = `data:image/png;base64,${signature.toString('base64')}`;

  console.log('Creando datos de demonstracion…\n');

  /* 1. Draft ------------------------------------------------------------- */
  const draft = await service.createEnvelope({
    title: 'Anexo de servicios 2027 (borrador)',
    documentBase64: contract.toString('base64'),
    fileName: 'anexo-2027.pdf',
    message: 'Pendiente de revisar el importe antes de enviarlo.',
    signatureLevel: 'simple',
    signingOrder: 'sequential',
    recipients: [
      { name: 'Marta Gil', email: 'marta@empresa.com', role: 'signer', order: 1, ref: 'r1' },
    ],
    fields: [
      {
        id: 'firma',
        type: 'signature',
        required: true,
        recipientRef: 'r1',
        placement: { page: 1, x: 48, y: 540, width: 200, height: 55 },
      },
    ],
  });
  console.log(`  [borrador]  ${draft.title}`);
  console.log(`              ${draft.id}`);

  /* 2. Sent, two sequential signers -------------------------------------- */
  const sent = await service.createEnvelope({
    title: 'Acuerdo marco de servicios',
    documentBase64: contract.toString('base64'),
    fileName: 'acuerdo-marco.pdf',
    message: 'Gracias por revisar el acuerdo. Te dejo los enlaces de firma.',
    signatureLevel: 'simple',
    signingOrder: 'sequential',
    recipients: [
      { name: 'Ana Ruiz', email: 'ana@empresa.com', role: 'signer', order: 1, ref: 'r1' },
      { name: 'Luis Diaz', email: 'luis@empresa.com', role: 'signer', order: 2, ref: 'r2' },
      { name: 'Equipo Legal', email: 'legal@empresa.com', role: 'cc', order: 3, ref: 'r3' },
    ],
    fields: [
      {
        id: 'firma1',
        type: 'signature',
        required: true,
        recipientRef: 'r1',
        placement: { page: 1, x: 48, y: 540, width: 200, height: 55 },
      },
      {
        id: 'fecha1',
        type: 'date',
        label: 'Fecha de firma',
        required: true,
        recipientRef: 'r1',
        placement: { page: 1, x: 48, y: 600, width: 120, height: 26 },
      },
      {
        id: 'firma2',
        type: 'signature',
        required: true,
        recipientRef: 'r2',
        placement: { page: 1, x: 320, y: 540, width: 200, height: 55 },
      },
    ],
  });
  service.sendEnvelope(sent.id);
  const sentRecipients = service.getEnvelopeDetail(sent.id)!.recipients;
  console.log(`\n  [enviado]   ${sent.title}`);
  console.log(`              ${sent.id}`);
  for (const recipient of sentRecipients) {
    console.log(`              ${recipient.role.padEnd(6)} ${recipient.name} -> /sign/${recipient.token}`);
  }

  /* 3. Completed, with a signed PDF and a full audit trail ---------------- */
  const completed = await service.createEnvelope({
    title: 'Orden de trabajo 0148 (firmado)',
    documentBase64: contract.toString('base64'),
    fileName: 'orden-0148.pdf',
    message: 'Documento firmado y archivado.',
    signatureLevel: 'simple',
    signingOrder: 'sequential',
    recipients: [
      { name: 'Ana Ruiz', email: 'ana@empresa.com', role: 'signer', order: 1, ref: 'r1' },
    ],
    fields: [
      {
        id: 'firma',
        type: 'signature',
        required: true,
        recipientRef: 'r1',
        placement: { page: 1, x: 48, y: 540, width: 200, height: 55 },
      },
      {
        id: 'fecha',
        type: 'date',
        label: 'Fecha de firma',
        required: true,
        recipientRef: 'r1',
        placement: { page: 1, x: 48, y: 600, width: 120, height: 26 },
      },
    ],
  });
  service.sendEnvelope(completed.id);
  const completedRecipient = service.getEnvelopeDetail(completed.id)!.recipients[0];
  await service.sign(
    completedRecipient.token,
    {
      values: { [`${completed.id}_fecha`]: new Date().toISOString().slice(0, 10) },
      signatureImage: signatureDataUrl,
      consentAccepted: true,
    },
    { ip: '127.0.0.1', userAgent: 'demo-seed' },
  );
  const finished = service.getEnvelopeDetail(completed.id)!;
  console.log(`\n  [firmado]   ${finished.title}`);
  console.log(`              ${finished.id}`);
  console.log(`              ${finished.audit.length} eventos de auditoria`);
  console.log(`              /api/envelopes/${finished.id}/signed  (PDF firmado)`);

  console.log('\nListo. Abre http://127.0.0.1:4310 para verlo.');
  store.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
