/**
 * Shared contract for the DEPARTIFY electronic signature service.
 *
 * This module is the single source of truth for the wire format between the
 * local server, the web client and any future DEPARTIFY integration (CRM
 * contacts, automations, MCP tools). It intentionally contains no I/O and no
 * runtime dependencies beyond zod so it can be consumed from Node, the
 * browser and MCP servers alike.
 */
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Enumerations                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Signature assurance levels, ordered from weakest to strongest.
 *
 * Levels are modelled after the assurance ladder observed in the reference
 * product (simple click, simple + SMS OTP, advanced certificate, qualified).
 * Only the levels that can be honoured locally are executable; the rest are
 * declared so that the contract stays stable when a trust service is added.
 */
export const SIGNATURE_LEVELS = ['simple', 'simple_otp', 'advanced', 'qualified'] as const;
export type SignatureLevel = (typeof SIGNATURE_LEVELS)[number];

export const SIGNATURE_LEVEL_LABELS: Record<SignatureLevel, string> = {
  simple: 'Simple signature',
  simple_otp: 'Simple signature with OTP verification',
  advanced: 'Advanced signature (certificate issued)',
  qualified: 'Qualified signature (qualified certificate)',
};

/** Legal / assurance note rendered next to each level in the UI. */
export const SIGNATURE_LEVEL_NOTES: Record<SignatureLevel, string> = {
  simple: 'Probative value, the signatory cannot be uniquely identified.',
  simple_otp: 'Adds a one-time code sent to the signatory to confirm identity.',
  advanced: 'Signer identified through a certificate valid for a period of time.',
  qualified: 'Highest legal certainty, certificate issued by an accredited provider.',
};

/** Whether a recipient must act, or only receives a copy. */
export const RECIPIENT_ROLES = ['signer', 'cc'] as const;
export type RecipientRole = (typeof RECIPIENT_ROLES)[number];

/** Sequential signing means recipient N+1 only starts after N signed. */
export const SIGNING_ORDERS = ['sequential', 'parallel'] as const;
export type SigningOrder = (typeof SIGNING_ORDERS)[number];

/**
 * Field kinds a document can carry.
 *
 * `signature` and `initials` carry a drawn image; `text`, `date` and `dropdown`
 * carry a value; `checkbox` carries a boolean.
 */
export const FIELD_TYPES = [
  'signature',
  'initials',
  'text',
  'date',
  'checkbox',
  'dropdown',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Lifecycle of a signature request. */
export const ENVELOPE_STATUSES = [
  'draft',
  'sent',
  'partially_signed',
  'completed',
  'declined',
  'expired',
  'cancelled',
] as const;
export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

/** Lifecycle of a single recipient inside an envelope. */
export const RECIPIENT_STATUSES = [
  'pending',
  'viewed',
  'signed',
  'declined',
  'skipped',
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

/** Events recorded in the tamper-evident audit trail. */
export const AUDIT_EVENT_TYPES = [
  'envelope.created',
  'envelope.sent',
  'envelope.viewed',
  'envelope.reminded',
  'recipient.viewed',
  'recipient.verified',
  'recipient.signed',
  'recipient.declined',
  'field.completed',
  'envelope.completed',
  'envelope.declined',
  'envelope.cancelled',
  'envelope.expired',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

/** A field placed on a specific page of the document, in PDF points. */
export const fieldPlacementSchema = z.object({
  /** 1-based page number. */
  page: z.number().int().min(1),
  /** Distance from the left edge of the page, in PDF points. */
  x: z.number().min(0),
  /** Distance from the top edge of the page, in PDF points. */
  y: z.number().min(0),
  /** Width of the field box, in PDF points. */
  width: z.number().positive(),
  /** Height of the field box, in PDF points. */
  height: z.number().positive(),
});
export type FieldPlacement = z.infer<typeof fieldPlacementSchema>;

/** A recipient of a signature request. */
export const recipientInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(320),
  role: z.enum(RECIPIENT_ROLES).default('signer'),
  /** Position in the signing sequence, 1-based. */
  order: z.number().int().min(1).default(1),
  /**
   * Stable client-side identifier. The editor uses it to attach fields to a
   * recipient before the server assigns its own ids.
   */
  ref: z.string().trim().min(1).max(64).optional(),
  /** Optional message shown to the recipient. */
  message: z.string().trim().max(2000).optional(),
});
export type RecipientInput = z.infer<typeof recipientInputSchema>;

/** A field to place on the document. */
export const fieldInputSchema = z.object({
  id: z.string().trim().min(1).max(64),
  type: z.enum(FIELD_TYPES),
  label: z.string().trim().max(200).optional(),
  required: z.boolean().default(false),
  /** Recipient this field belongs to, referenced by the recipient `ref`. */
  recipientRef: z.string().trim().min(1).max(64).optional(),
  placement: fieldPlacementSchema,
  /** Allowed values for `dropdown` fields. */
  options: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  /** Placeholder shown for empty text fields. */
  placeholder: z.string().trim().max(200).optional(),
});
export type FieldInput = z.infer<typeof fieldInputSchema>;

/** Request body used to create a signature request. */
export const createEnvelopeSchema = z.object({
  title: z.string().trim().min(1).max(200),
  /** Base64 PDF content. */
  documentBase64: z.string().min(1),
  /** Original file name, kept for display and audit purposes. */
  fileName: z.string().trim().max(255).optional(),
  message: z.string().trim().max(4000).optional(),
  signatureLevel: z.enum(SIGNATURE_LEVELS).default('simple'),
  signingOrder: z.enum(SIGNING_ORDERS).default('sequential'),
  recipients: z.array(recipientInputSchema).min(1).max(50),
  fields: z.array(fieldInputSchema).max(200).default([]),
  /** Days before the request expires. */
  expiresInDays: z.number().int().min(1).max(365).optional(),
  /** Free-form metadata forwarded to DEPARTIFY, e.g. a CRM contact id. */
  metadata: z.record(z.unknown()).optional(),
});
export type CreateEnvelopeInput = z.infer<typeof createEnvelopeSchema>;

/** Payload sent by a recipient when signing. */
export const signRequestSchema = z.object({
  /** Values keyed by field id. */
  values: z.record(z.union([z.string(), z.boolean()])).default({}),
  /** Drawn signature as a data URL, or base64 PNG payload. */
  signatureImage: z.string().max(2_000_000).optional(),
  /** OTP code entered by the signatory for `simple_otp` envelopes. */
  otp: z.string().trim().max(12).optional(),
  /** Free-text name typed by the signatory. */
  typedName: z.string().trim().max(200).optional(),
  /** Whether the signatory accepted the consent text. */
  consentAccepted: z.boolean().default(false),
});
export type SignRequest = z.infer<typeof signRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Entities                                                                    */
/* -------------------------------------------------------------------------- */

export interface DocumentRecord {
  id: string;
  fileName: string;
  byteSize: number;
  pageCount: number;
  sha256: string;
  createdAt: string;
}

export interface RecipientRecord {
  id: string;
  envelopeId: string;
  name: string;
  email: string;
  role: RecipientRole;
  order: number;
  message?: string;
  status: RecipientStatus;
  /** Public token used by the signer to open the signing room. */
  token: string;
  /** Timestamp of the last view by the recipient. */
  viewedAt?: string;
  signedAt?: string;
  /** OTP hash and expiry, present for `simple_otp` envelopes. */
  otpHash?: string;
  otpExpiresAt?: string;
}

export interface FieldRecord {
  id: string;
  envelopeId: string;
  recipientId?: string;
  type: FieldType;
  label?: string;
  required: boolean;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  options?: string[];
  placeholder?: string;
  value?: string;
  completedAt?: string;
}

export interface AuditEventRecord {
  id: string;
  envelopeId: string;
  type: AuditEventType;
  actor: string;
  /** ISO timestamp. */
  at: string;
  /** IP address of the actor, when known. */
  ip?: string;
  userAgent?: string;
  /** Free-form event detail. */
  detail?: Record<string, unknown>;
  /** Hash of the previous event, forming a tamper-evident chain. */
  prevHash: string;
  /** SHA-256 over this event and the previous hash. */
  hash: string;
}

export interface EnvelopeRecord {
  id: string;
  title: string;
  fileName: string;
  message?: string;
  signatureLevel: SignatureLevel;
  signingOrder: SigningOrder;
  status: EnvelopeStatus;
  /** SHA-256 of the original document. */
  documentSha256: string;
  pageCount: number;
  expiresAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

/** Envelope enriched with its recipients, fields and audit trail. */
export interface EnvelopeDetail extends EnvelopeRecord {
  recipients: RecipientRecord[];
  fields: FieldRecord[];
  audit: AuditEventRecord[];
  /** Relative URL of the signed PDF, available once completed. */
  signedDocumentPath?: string;
}

/** Public payload handed to a signer; never exposes another recipient's data. */
export interface SigningRoomPayload {
  envelopeId: string;
  title: string;
  message?: string;
  signatureLevel: SignatureLevel;
  fileName: string;
  pageCount: number;
  /** Public URL of the document to display. */
  documentUrl: string;
  recipient: {
    name: string;
    email: string;
    role: RecipientRole;
    order: number;
    message?: string;
    status: RecipientStatus;
  };
  /** Only the fields this recipient must complete. */
  fields: Array<
    Pick<
      FieldRecord,
      'id' | 'type' | 'label' | 'required' | 'page' | 'x' | 'y' | 'width' | 'height' | 'options' | 'placeholder' | 'value'
    >
  >;
  /** Whether an OTP is required before signing. */
  requiresOtp: boolean;
  status: EnvelopeStatus;
  expiresAt?: string;
  /** Consent text the signer must accept. */
  consentText: string;
}

/** Summary row used by list views. */
export interface EnvelopeSummary {
  id: string;
  title: string;
  fileName: string;
  status: EnvelopeStatus;
  signatureLevel: SignatureLevel;
  signingOrder: SigningOrder;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  expiresAt?: string;
  totalRecipients: number;
  signedRecipients: number;
}

/* -------------------------------------------------------------------------- */
/* API surface                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * REST endpoints. Kept in one place so the DEPARTIFY CRM and any MCP tool can
 * call the service without hardcoding strings.
 */
export const API_ROUTES = {
  health: '/api/health',
  envelopes: '/api/envelopes',
  envelope: (id: string) => `/api/envelopes/${id}`,
  envelopeSend: (id: string) => `/api/envelopes/${id}/send`,
  envelopeRemind: (id: string) => `/api/envelopes/${id}/remind`,
  envelopeCancel: (id: string) => `/api/envelopes/${id}/cancel`,
  envelopeAudit: (id: string) => `/api/envelopes/${id}/audit`,
  envelopeDocument: (id: string) => `/api/envelopes/${id}/document`,
  envelopeSigned: (id: string) => `/api/envelopes/${id}/signed`,
  envelopeAuditVerify: (id: string) => `/api/envelopes/${id}/audit/verify`,
  otpRequest: (token: string) => `/api/signing/${token}/otp`,
  otpVerify: (token: string) => `/api/signing/${token}/otp/verify`,
  signingRoom: (token: string) => `/api/signing/${token}`,
  sign: (token: string) => `/api/signing/${token}/sign`,
  decline: (token: string) => `/api/signing/${token}/decline`,
} as const;

/** Consent text shown before a signature is applied. */
export const DEFAULT_CONSENT_TEXT =
  'I agree that this electronic signature is legally binding and I consent to the processing of my personal data for the purpose of signing this document.';

/** Number of pages a signature request may contain. */
export const MAX_DOCUMENT_PAGES = 50;

/** Maximum accepted document size in bytes (15 MB). */
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
