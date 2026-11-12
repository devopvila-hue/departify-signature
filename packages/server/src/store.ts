/**
 * SQLite persistence layer built on the Node standard library (`node:sqlite`).
 *
 * Using the built-in driver keeps the project free of native build steps, so
 * `pnpm install` works on any machine without a compiler and the local server
 * starts with a single command.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AuditEventRecord,
  AuditEventType,
  DocumentRecord,
  EnvelopeRecord,
  EnvelopeStatus,
  FieldRecord,
  RecipientRecord,
  RecipientStatus,
} from '@signatureit/shared';

const SCHEMA = `
PRAGMA busy_timeout = 10000;
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  file_name   TEXT NOT NULL,
  byte_size   INTEGER NOT NULL,
  page_count  INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  content     BLOB NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS envelopes (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  file_name        TEXT NOT NULL,
  message          TEXT,
  signature_level  TEXT NOT NULL,
  signing_order    TEXT NOT NULL,
  status           TEXT NOT NULL,
  document_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_sha256  TEXT NOT NULL,
  page_count       INTEGER NOT NULL,
  expires_at       TEXT,
  completed_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  metadata         TEXT
);

CREATE TABLE IF NOT EXISTS recipients (
  id               TEXT PRIMARY KEY,
  envelope_id      TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL,
  role             TEXT NOT NULL,
  "order"          INTEGER NOT NULL,
  message          TEXT,
  status           TEXT NOT NULL,
  token            TEXT NOT NULL UNIQUE,
  viewed_at        TEXT,
  signed_at        TEXT,
  otp_hash         TEXT,
  otp_expires_at   TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fields (
  id            TEXT PRIMARY KEY,
  envelope_id   TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  recipient_id  TEXT REFERENCES recipients(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  label         TEXT,
  required      INTEGER NOT NULL DEFAULT 0,
  page          INTEGER NOT NULL,
  x             REAL NOT NULL,
  y             REAL NOT NULL,
  width         REAL NOT NULL,
  height        REAL NOT NULL,
  options       TEXT,
  placeholder   TEXT,
  value         TEXT,
  completed_at  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id           TEXT PRIMARY KEY,
  envelope_id  TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  actor        TEXT NOT NULL,
  at           TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  detail       TEXT,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recipients_envelope ON recipients(envelope_id);
CREATE INDEX IF NOT EXISTS idx_fields_envelope ON fields(envelope_id);
CREATE INDEX IF NOT EXISTS idx_audit_envelope ON audit_events(envelope_id);
`;

interface EnvelopeRow {
  id: string;
  title: string;
  file_name: string;
  message: string | null;
  signature_level: string;
  signing_order: string;
  status: string;
  document_id: string;
  document_sha256: string;
  page_count: number;
  expires_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: string | null;
}

interface RecipientRow {
  id: string;
  envelope_id: string;
  name: string;
  email: string;
  role: string;
  order: number;
  message: string | null;
  status: string;
  token: string;
  viewed_at: string | null;
  signed_at: string | null;
  otp_hash: string | null;
  otp_expires_at: string | null;
}

interface FieldRow {
  id: string;
  envelope_id: string;
  recipient_id: string | null;
  type: string;
  label: string | null;
  required: number;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  options: string | null;
  placeholder: string | null;
  value: string | null;
  completed_at: string | null;
}

interface AuditRow {
  id: string;
  envelope_id: string;
  type: string;
  actor: string;
  at: string;
  ip: string | null;
  user_agent: string | null;
  detail: string | null;
  prev_hash: string;
  hash: string;
}

export interface ActorContext {
  ip?: string;
  userAgent?: string;
}

/** Canonical JSON used when hashing audit events, so hashes are reproducible. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Persistent store for documents, envelopes, recipients, fields and the
 * tamper-evident audit trail.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    // Applying the schema switches the journal mode, which needs a brief
    // exclusive lock; another process may be holding it.
    this.runWithRetry(() => this.db.exec(SCHEMA));
  }

  close(): void {
    this.db.close();
  }

  /* ------------------------------ transactions ---------------------------- */

  /**
   * Runs a unit of work inside a single write transaction.
   *
   * `BEGIN IMMEDIATE` acquires the write lock up front, so a multi-statement
   * operation (create envelope + recipients + fields + audit event) is atomic
   * and never fails halfway through when another process holds the database.
   */
  transaction<T>(fn: () => T): T {
    this.runWithRetry(() => this.db.exec('BEGIN IMMEDIATE'));
    try {
      const result = fn();
      this.runWithRetry(() => this.db.exec('COMMIT'));
      return result;
    } catch (error) {
      try {
        this.runWithRetry(() => this.db.exec('ROLLBACK'));
      } catch {
        // The transaction was already closed; the original error is the useful one.
      }
      throw error;
    }
  }

  /**
   * Executes a write statement, retrying briefly when SQLite reports the
   * database is busy. `busy_timeout` covers most waits, but a lock upgrade
   * can still surface SQLITE_BUSY immediately.
   */
  private exec(sql: string, ...params: Array<string | number | bigint | null | Uint8Array>): void {
    this.runWithRetry(() => {
      const statement = this.db.prepare(sql);
      return params.length > 0 ? statement.run(...params) : statement.run();
    });
  }

  /** Retries an operation while SQLite reports the database is locked. */
  private runWithRetry<T>(operation: () => T, attempts = 5): T {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return operation();
      } catch (error) {
        const code = (error as { errcode?: number }).errcode;
        const message = String((error as Error).message ?? '');
        const busy = code === 5 || message.includes('database is locked');
        if (!busy) throw error;
        lastError = error;
        // Brief backoff: the lock is usually released within a few ms.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      }
    }
    throw lastError;
  }

  /* ------------------------------- documents ------------------------------ */

  createDocument(params: {
    fileName: string;
    content: Buffer;
    pageCount: number;
  }): DocumentRecord {
    const id = `doc_${randomUUID()}`;
    const sha256 = createHash('sha256').update(params.content).digest('hex');
    const createdAt = new Date().toISOString();
    this.exec(
      `INSERT INTO documents (id, file_name, byte_size, page_count, sha256, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      params.fileName,
      params.content.byteLength,
      params.pageCount,
      sha256,
      params.content,
      createdAt,
    );
    return {
      id,
      fileName: params.fileName,
      byteSize: params.content.byteLength,
      pageCount: params.pageCount,
      sha256,
      createdAt,
    };
  }

  getDocumentContent(documentId: string): { content: Buffer; fileName: string } | undefined {
    const row = this.db
      .prepare(`SELECT content, file_name FROM documents WHERE id = ?`)
      .get(documentId) as { content: Uint8Array; file_name: string } | undefined;
    if (!row) return undefined;
    return { content: Buffer.from(row.content), fileName: row.file_name };
  }

  getDocument(documentId: string): DocumentRecord | undefined {
    return this.findDocument(`SELECT id, file_name, byte_size, page_count, sha256, created_at FROM documents WHERE id = ?`, documentId);
  }

  /** Finds a stored document by its content hash. */
  getDocumentBySha256(sha256: string): DocumentRecord | undefined {
    return this.findDocument(
      `SELECT id, file_name, byte_size, page_count, sha256, created_at
       FROM documents WHERE sha256 = ? ORDER BY created_at ASC LIMIT 1`,
      sha256,
    );
  }

  private findDocument(sql: string, value: string): DocumentRecord | undefined {
    const row = this.db.prepare(sql).get(value) as
      | {
          id: string;
          file_name: string;
          byte_size: number;
          page_count: number;
          sha256: string;
          created_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      fileName: row.file_name,
      byteSize: row.byte_size,
      pageCount: row.page_count,
      sha256: row.sha256,
      createdAt: row.created_at,
    };
  }

  /* -------------------------------- envelopes ----------------------------- */

  createEnvelope(params: {
    title: string;
    fileName: string;
    message?: string;
    signatureLevel: string;
    signingOrder: string;
    documentId: string;
    documentSha256: string;
    pageCount: number;
    expiresAt?: string;
    metadata?: Record<string, unknown>;
  }): EnvelopeRecord {
    const id = `env_${randomUUID()}`;
    const now = new Date().toISOString();
    this.exec(
      `INSERT INTO envelopes
         (id, title, file_name, message, signature_level, signing_order, status, document_id,
          document_sha256, page_count, expires_at, completed_at, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, NULL, ?, ?, ?)`,
      id,
      params.title,
      params.fileName,
      params.message ?? null,
      params.signatureLevel,
      params.signingOrder,
      params.documentId,
      params.documentSha256,
      params.pageCount,
      params.expiresAt ?? null,
      now,
      now,
      params.metadata ? JSON.stringify(params.metadata) : null,
    );
    return this.getEnvelope(id)!;
  }

  getEnvelope(envelopeId: string): EnvelopeRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM envelopes WHERE id = ?`).get(envelopeId) as
      | EnvelopeRow
      | undefined;
    return row ? mapEnvelope(row) : undefined;
  }

  listEnvelopes(): EnvelopeRecord[] {
    const rows = this.db.prepare(`SELECT * FROM envelopes ORDER BY created_at DESC`).all() as unknown as EnvelopeRow[];
    return rows.map(mapEnvelope);
  }

  updateEnvelopeStatus(envelopeId: string, status: EnvelopeStatus, completedAt?: string): void {
    this.exec(
      `UPDATE envelopes SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?`,
      status,
      new Date().toISOString(),
      completedAt ?? null,
      envelopeId,
    );
  }

  /** Integration references only; never replaces documents or audit evidence. */
  setEnvelopeMetadata(envelopeId: string, metadata: Record<string, unknown>): void {
    this.exec('UPDATE envelopes SET metadata = ? WHERE id = ?', JSON.stringify(metadata), envelopeId);
  }

  touchEnvelope(envelopeId: string): void {
    this.exec(`UPDATE envelopes SET updated_at = ? WHERE id = ?`, new Date().toISOString(), envelopeId);
  }

  /* -------------------------------- recipients ---------------------------- */

  createRecipient(params: {
    envelopeId: string;
    name: string;
    email: string;
    role: string;
    order: number;
    message?: string;
  }): RecipientRecord {
    const id = `rcp_${randomUUID()}`;
    const token = randomBytes(24).toString('base64url');
    const createdAt = new Date().toISOString();
    this.exec(
      `INSERT INTO recipients
         (id, envelope_id, name, email, role, "order", message, status, token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      params.envelopeId,
      params.name,
      params.email,
      params.role,
      params.order,
      params.message ?? null,
      token,
      createdAt,
    );
    return this.getRecipient(id)!;
  }

  getRecipient(recipientId: string): RecipientRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM recipients WHERE id = ?`).get(recipientId) as
      | RecipientRow
      | undefined;
    return row ? mapRecipient(row) : undefined;
  }

  getRecipientByToken(token: string): RecipientRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM recipients WHERE token = ?`).get(token) as
      | RecipientRow
      | undefined;
    return row ? mapRecipient(row) : undefined;
  }

  listRecipients(envelopeId: string): RecipientRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM recipients WHERE envelope_id = ? ORDER BY "order" ASC, created_at ASC`)
      .all(envelopeId) as unknown as RecipientRow[];
    return rows.map(mapRecipient);
  }

  updateRecipientStatus(recipientId: string, status: RecipientStatus, signedAt?: string): void {
    this.exec(
      `UPDATE recipients SET status = ?, signed_at = COALESCE(?, signed_at) WHERE id = ?`,
      status,
      signedAt ?? null,
      recipientId,
    );
  }

  markRecipientViewed(recipientId: string): void {
    this.exec(
      `UPDATE recipients SET viewed_at = ?, status = CASE WHEN status = 'pending' THEN 'viewed' ELSE status END WHERE id = ?`,
      new Date().toISOString(),
      recipientId,
    );
  }

  setRecipientOtp(recipientId: string, otpHash: string, expiresAt: string): void {
    this.exec(
      `UPDATE recipients SET otp_hash = ?, otp_expires_at = ? WHERE id = ?`,
      otpHash,
      expiresAt,
      recipientId,
    );
  }

  clearRecipientOtp(recipientId: string): void {
    this.exec(`UPDATE recipients SET otp_hash = NULL, otp_expires_at = NULL WHERE id = ?`, recipientId);
  }

  /* ---------------------------------- fields ------------------------------ */

  createField(params: {
    id: string;
    envelopeId: string;
    recipientId?: string;
    type: string;
    label?: string;
    required: boolean;
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    options?: string[];
    placeholder?: string;
  }): FieldRecord {
    this.exec(
      `INSERT INTO fields
         (id, envelope_id, recipient_id, type, label, required, page, x, y, width, height,
          options, placeholder, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params.id,
      params.envelopeId,
      params.recipientId ?? null,
      params.type,
      params.label ?? null,
      params.required ? 1 : 0,
      params.page,
      params.x,
      params.y,
      params.width,
      params.height,
      params.options ? JSON.stringify(params.options) : null,
      params.placeholder ?? null,
      new Date().toISOString(),
    );
    return this.getField(params.id)!;
  }

  getField(fieldId: string): FieldRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM fields WHERE id = ?`).get(fieldId) as FieldRow | undefined;
    return row ? mapField(row) : undefined;
  }

  listFields(envelopeId: string): FieldRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM fields WHERE envelope_id = ? ORDER BY page ASC, y ASC, x ASC`)
      .all(envelopeId) as unknown as FieldRow[];
    return rows.map(mapField);
  }

  setFieldValue(fieldId: string, value: string): void {
    this.exec(
      `UPDATE fields SET value = ?, completed_at = ? WHERE id = ?`,
      value,
      new Date().toISOString(),
      fieldId,
    );
  }

  /* -------------------------------- audit trail --------------------------- */

  /**
   * Appends an event to the audit trail. Each event stores the hash of the
   * previous event, so altering or removing history invalidates every
   * subsequent hash.
   */
  appendAuditEvent(params: {
    envelopeId: string;
    type: AuditEventType;
    actor: string;
    detail?: Record<string, unknown>;
    context?: ActorContext;
  }): AuditEventRecord {
    const previous = this.db
      .prepare(`SELECT hash FROM audit_events WHERE envelope_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(params.envelopeId) as { hash: string } | undefined;
    const prevHash = previous?.hash ?? 'genesis';
    const at = new Date().toISOString();
    const id = `evt_${randomUUID()}`;
    const payload = {
      id,
      envelopeId: params.envelopeId,
      type: params.type,
      actor: params.actor,
      at,
      ip: params.context?.ip ?? null,
      userAgent: params.context?.userAgent ?? null,
      detail: params.detail ?? null,
      prevHash,
    };
    const hash = createHash('sha256').update(canonicalJson(payload)).digest('hex');
    this.exec(
      `INSERT INTO audit_events (id, envelope_id, type, actor, at, ip, user_agent, detail, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      params.envelopeId,
      params.type,
      params.actor,
      at,
      params.context?.ip ?? null,
      params.context?.userAgent ?? null,
      params.detail ? JSON.stringify(params.detail) : null,
      prevHash,
      hash,
    );
    return { ...payload, detail: params.detail, hash, prevHash } as AuditEventRecord;
  }

  listAuditEvents(envelopeId: string): AuditEventRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM audit_events WHERE envelope_id = ? ORDER BY rowid ASC`)
      .all(envelopeId) as unknown as AuditRow[];
    return rows.map(mapAudit);
  }
}

function mapEnvelope(row: EnvelopeRow): EnvelopeRecord {
  return {
    id: row.id,
    title: row.title,
    fileName: row.file_name,
    message: row.message ?? undefined,
    signatureLevel: row.signature_level as EnvelopeRecord['signatureLevel'],
    signingOrder: row.signing_order as EnvelopeRecord['signingOrder'],
    status: row.status as EnvelopeStatus,
    documentSha256: row.document_sha256,
    pageCount: row.page_count,
    expiresAt: row.expires_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
  };
}

function mapRecipient(row: RecipientRow): RecipientRecord {
  return {
    id: row.id,
    envelopeId: row.envelope_id,
    name: row.name,
    email: row.email,
    role: row.role as RecipientRecord['role'],
    order: row.order,
    message: row.message ?? undefined,
    status: row.status as RecipientStatus,
    token: row.token,
    viewedAt: row.viewed_at ?? undefined,
    signedAt: row.signed_at ?? undefined,
    otpHash: row.otp_hash ?? undefined,
    otpExpiresAt: row.otp_expires_at ?? undefined,
  };
}

function mapField(row: FieldRow): FieldRecord {
  return {
    id: row.id,
    envelopeId: row.envelope_id,
    recipientId: row.recipient_id ?? undefined,
    type: row.type as FieldRecord['type'],
    label: row.label ?? undefined,
    required: row.required === 1,
    page: row.page,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    options: row.options ? (JSON.parse(row.options) as string[]) : undefined,
    placeholder: row.placeholder ?? undefined,
    value: row.value ?? undefined,
    completedAt: row.completed_at ?? undefined,
  };
}

function mapAudit(row: AuditRow): AuditEventRecord {
  return {
    id: row.id,
    envelopeId: row.envelope_id,
    type: row.type as AuditEventType,
    actor: row.actor,
    at: row.at,
    ip: row.ip ?? undefined,
    userAgent: row.user_agent ?? undefined,
    detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : undefined,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}
