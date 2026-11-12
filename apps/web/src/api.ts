/**
 * Thin API client. Every call goes through `request` so errors surface as a
 * single, predictable shape for the UI.
 */
import { mountedUrl } from './mount';
import type {
  EnvelopeDetail,
  EnvelopeSummary,
  SigningRoomPayload,
  SignRequest,
} from '@signatureit/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(mountedUrl(path), {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json() : await response.text();
  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : `Request failed with status ${response.status}`;
    const code =
      typeof payload === 'object' && payload && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : 'request_failed';
    throw new ApiError(message, code, response.status);
  }
  return payload as T;
}

export interface CreateEnvelopePayload {
  title: string;
  documentBase64: string;
  fileName?: string;
  message?: string;
  signatureLevel: string;
  signingOrder: string;
  recipients: Array<{
    name: string;
    email: string;
    role: 'signer' | 'cc';
    order: number;
    message?: string;
  }>;
  fields: Array<{
    id: string;
    type: string;
    label?: string;
    required: boolean;
    recipientId?: string;
    placement: { page: number; x: number; y: number; width: number; height: number };
    options?: string[];
    placeholder?: string;
  }>;
  expiresInDays?: number;
  metadata?: Record<string, unknown>;
}

export const api = {
  health: () => request<{ status: string }>('/api/health'),

  listEnvelopes: () =>
    request<{ envelopes: EnvelopeSummary[] }>('/api/envelopes').then((r) => r.envelopes),

  getEnvelope: (id: string) =>
    request<{ envelope: EnvelopeDetail }>(`/api/envelopes/${id}`).then((r) => r.envelope),

  createEnvelope: (payload: CreateEnvelopePayload) =>
    request<{ envelope: EnvelopeDetail }>('/api/envelopes', {
      method: 'POST',
      body: JSON.stringify(payload),
    }).then((r) => r.envelope),

  sendEnvelope: (id: string) =>
    request<{
      envelope: EnvelopeDetail;
      links: Array<{ recipientId: string; name: string; email: string; role: string; order: number; url: string }>;
    }>(`/api/envelopes/${id}/send`, { method: 'POST' }),

  remindEnvelope: (id: string) =>
    request<{ envelope: EnvelopeDetail }>(`/api/envelopes/${id}/remind`, { method: 'POST' }),

  cancelEnvelope: (id: string) =>
    request<{ envelope: EnvelopeDetail }>(`/api/envelopes/${id}/cancel`, { method: 'POST' }),

  getAudit: (id: string) =>
    request<{
      audit: EnvelopeDetail['audit'];
      verification: { valid: boolean; checked: number; headHash: string; brokenAt?: string; reason?: string };
    }>(`/api/envelopes/${id}/audit`),

  getSigningRoom: (token: string) =>
    request<{ room: SigningRoomPayload }>(`/api/signing/${token}`).then((r) => r.room),

  requestOtp: (token: string) =>
    request<{ sent: boolean; code?: string; expiresAt?: string }>(`/api/signing/${token}/otp`, {
      method: 'POST',
    }),

  verifyOtp: (token: string, code: string) =>
    request<{ verified: boolean }>(`/api/signing/${token}/otp/verify`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  sign: (token: string, payload: SignRequest) =>
    request<{ envelope: EnvelopeDetail }>(`/api/signing/${token}/sign`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }).then((r) => r.envelope),

  decline: (token: string, reason: string) =>
    request<{ envelope: EnvelopeDetail }>(`/api/signing/${token}/decline`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }).then((r) => r.envelope),
};

/** Reads a PDF file as a base64 payload without the data-url prefix. */
export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
