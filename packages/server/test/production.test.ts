import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { Store } from '../src/store.js';
import { SignatureService } from '../src/service.js';
import { buildServer } from '../src/routes.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('production rejects unsupported assurance and public mutation never discloses other recipient bearer tokens', async () => {
 const store = new Store(':memory:');
 const service = new SignatureService(store, mkdtempSync(join(tmpdir(), 'sign-prod-')));
 const app = await buildServer({ store, service, production: true });
 try {
  const pdf = await PDFDocument.create(); pdf.addPage();
  const payload = { title: 'QA', documentBase64: Buffer.from(await pdf.save()).toString('base64'), signatureLevel: 'simple', signingOrder: 'parallel', recipients: [{ name:'QA One',email:'one@example.invalid',role:'signer',order:1 },{ name:'QA Two',email:'two@example.invalid',role:'signer',order:2 }], fields: [] };
  const unsupported = await app.inject({method:'POST',url:'/api/envelopes',payload:{...payload,signatureLevel:'qualified'}});
  assert.equal(unsupported.statusCode,409);
  const created = await app.inject({method:'POST',url:'/api/envelopes',payload});
  assert.equal(created.statusCode,201); const envelope = created.json().envelope;
  const token = envelope.recipients[0].token;
  assert.equal((await app.inject(`/api/signing/${token}/document`)).statusCode,410);
  await app.inject({method:'POST',url:`/api/envelopes/${envelope.id}/send`});
  assert.equal((await app.inject({method:'POST',url:`/api/signing/${token}/otp`})).statusCode,409);
  const signed = await app.inject({method:'POST',url:`/api/signing/${token}/sign`,payload:{values:{},consentAccepted:true}});
  assert.equal(signed.statusCode,200);
  assert.deepEqual(Object.keys(signed.json().envelope).sort(),['id','status']);
  assert.ok(!signed.body.includes(envelope.recipients[1].token));
  await app.inject({method:'POST',url:`/api/envelopes/${envelope.id}/cancel`});
  assert.equal((await app.inject(`/api/signing/${token}/document`)).statusCode,410);
 } finally { await app.close(); store.close(); }
});
