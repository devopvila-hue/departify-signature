/** Shared presentational helpers used across the app. */
import type { EnvelopeStatus, RecipientStatus } from '@signatureit/shared';

const ENVELOPE_LABELS: Record<EnvelopeStatus, string> = {
  draft: 'Borrador',
  sent: 'Enviado',
  partially_signed: 'Firmado parcialmente',
  completed: 'Completado',
  declined: 'Rechazado',
  expired: 'Caducado',
  cancelled: 'Cancelado',
};

const RECIPIENT_LABELS: Record<RecipientStatus, string> = {
  pending: 'Pendiente',
  viewed: 'Visto',
  signed: 'Firmado',
  declined: 'Rechazó',
  skipped: 'Omitido',
};

export function envelopeStatusLabel(status: EnvelopeStatus): string {
  return ENVELOPE_LABELS[status] ?? status;
}

export function recipientStatusLabel(status: RecipientStatus): string {
  return RECIPIENT_LABELS[status] ?? status;
}

/** Renders an ISO timestamp in the browser's locale, defensively. */
export function formatDate(iso?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Status badge for an envelope row. */
export function StatusBadge({ status }: { status: EnvelopeStatus }) {
  return (
    <span className={`badge badge-${status}`}>
      <span className="dot" />
      {envelopeStatusLabel(status)}
    </span>
  );
}
