/**
 * Envelope detail: recipients, signing links, audit trail and the signed
 * document download.
 */
import { useEffect, useState } from 'react';
import type { EnvelopeDetail } from '@signatureit/shared';
import { mountedUrl } from '../mount';
import { api } from '../api';
import { StatusBadge, formatDate, recipientStatusLabel } from '../ui';

const EVENT_LABELS: Record<string, string> = {
  'envelope.created': 'Solicitud creada',
  'envelope.sent': 'Enlaces de firma activados',
  'envelope.viewed': 'Documento abierto',
  'envelope.reminded': 'Recordatorio registrado',
  'recipient.viewed': 'Firmante abrió el documento',
  'recipient.verified': 'Identidad verificada',
  'recipient.signed': 'Firmante firmó',
  'recipient.declined': 'Firmante rechazó',
  'field.completed': 'Campo completado',
  'envelope.completed': 'Documento completado',
  'envelope.declined': 'Solicitud rechazada',
  'envelope.cancelled': 'Solicitud cancelada',
  'envelope.expired': 'Solicitud caducada',
};

export function EnvelopeDetailView({ envelopeId }: { envelopeId: string }) {
  const [envelope, setEnvelope] = useState<EnvelopeDetail | null>(null);
  const [links, setLinks] = useState<Array<{ name: string; email: string; url: string; role: string }>>([]);
  const [verification, setVerification] = useState<{
    valid: boolean;
    checked: number;
    headHash: string;
    brokenAt?: string;
    reason?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const [detail, audit] = await Promise.all([
        api.getEnvelope(envelopeId),
        api.getAudit(envelopeId),
      ]);
      setEnvelope(detail);
      setLinks(detail.status === 'draft' ? [] : detail.recipients.map(recipient => ({
        name: recipient.name, email: recipient.email, role: recipient.role, url: mountedUrl(`/sign/${recipient.token}`),
      })));
      setVerification(audit.verification);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo cargar la solicitud.');
    }
  };

  useEffect(() => {
    void load();
  }, [envelopeId]);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.sendEnvelope(envelopeId);
      setEnvelope(result.envelope);
      setLinks(result.links.map(link => ({ ...link, url: mountedUrl(link.url) })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo enviar.');
    } finally {
      setBusy(false);
    }
  };

  if (error && !envelope) {
    return (
      <main className="page">
        <div className="notice notice-error">{error}</div>
      </main>
    );
  }

  if (!envelope) {
    return (
      <main className="page">
        <div className="empty">Cargando solicitud…</div>
      </main>
    );
  }

  const signers = envelope.recipients.filter((r) => r.role === 'signer');
  const copies = envelope.recipients.filter((r) => r.role === 'cc');

  return (
    <main className="page">
      <div className="stack">
        <div className="row-between">
          <div>
            <a className="btn btn-sm btn-ghost" href="#/">
              ← Volver
            </a>
            <h1 style={{ fontSize: 26, marginTop: 10 }}>{envelope.title}</h1>
            <div className="row" style={{ marginTop: 8 }}>
              <StatusBadge status={envelope.status} />
              <span className="dim mono">{envelope.id}</span>
            </div>
          </div>
          <div className="row">
            {envelope.status === 'draft' && (
              <button className="btn btn-primary" onClick={() => void send()} disabled={busy}>
                Activar enlaces de firma
              </button>
            )}
            {envelope.status === 'completed' && (
              <>
                <a
                  className="btn"
                  href={mountedUrl(`/api/envelopes/${envelope.id}/signed?inline=1`)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Ver firmado
                </a>
                <a className="btn btn-primary" href={mountedUrl(`/api/envelopes/${envelope.id}/signed`)} download>
                  Descargar documento firmado
                </a>
              </>
            )}
          </div>
        </div>

        {error && <div className="notice notice-error">{error}</div>}

        <div className="grid grid-3">
          <div className="card card-pad">
            <div className="kpi">
              <span className="kpi-value">
                {signers.filter((r) => r.status === 'signed').length}/{signers.length}
              </span>
              <span className="kpi-label">Firmantes</span>
            </div>
          </div>
          <div className="card card-pad">
            <div className="kpi">
              <span className="kpi-value">{envelope.fields.length}</span>
              <span className="kpi-label">Campos</span>
            </div>
          </div>
          <div className="card card-pad">
            <div className="kpi">
              <span className="kpi-value">{envelope.audit.length}</span>
              <span className="kpi-label">Eventos de auditoría</span>
            </div>
          </div>
        </div>

        {links.length > 0 && (
          <div className="card">
            <div className="card-head">
              <span className="card-title">Enlaces de firma</span>
              <span className="dim">Comparte cada enlace con su destinatario</span>
            </div>
            <div className="card-body link-list">
              {links.map((link) => (
                <div className="link-chip" key={link.url}>
                  <strong>{link.name}</strong>
                  <span className="dim">{link.email}</span>
                  <span className="grow" />
                  <a href={link.url} target="_blank" rel="noreferrer">
                    Abrir
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-2">
          <div className="card">
            <div className="card-head">
              <span className="card-title">Firmantes</span>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Correo</th>
                  <th>Estado</th>
                  <th>Firmado</th>
                </tr>
              </thead>
              <tbody>
                {signers.map((recipient) => (
                  <tr key={recipient.id}>
                    <td style={{ fontWeight: 600 }}>{recipient.name}</td>
                    <td className="dim">{recipient.email}</td>
                    <td>{recipientStatusLabel(recipient.status)}</td>
                    <td className="dim">{formatDate(recipient.signedAt)}</td>
                  </tr>
                ))}
                {copies.map((recipient) => (
                  <tr key={recipient.id}>
                    <td style={{ fontWeight: 600 }}>
                      {recipient.name} <span className="dim">(copia)</span>
                    </td>
                    <td className="dim">{recipient.email}</td>
                    <td>—</td>
                    <td className="dim">—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Integridad de la auditoría</span>
              {verification && (
                <span className={`badge ${verification.valid ? 'badge-completed' : 'badge-declined'}`}>
                  {verification.valid ? 'Cadena válida' : 'Cadena alterada'}
                </span>
              )}
            </div>
            <div className="card-body stack" style={{ gap: 10 }}>
              {verification ? (
                <>
                  <div className="dim">
                    {verification.valid
                      ? `Los ${verification.checked} eventos encadenan correctamente.`
                      : `La cadena se rompe en el evento ${verification.brokenAt}: ${verification.reason}`}
                  </div>
                  <div className="mono dim">head: {verification.headHash}</div>
                </>
              ) : (
                <div className="dim">Sin datos de verificación.</div>
              )}
              <a className="btn btn-sm" href={mountedUrl(`/api/envelopes/${envelope.id}/document`)} target="_blank">
                Ver documento original
              </a>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">Registro de auditoría</span>
          </div>
          <div className="card-body">
            <div className="timeline">
              {envelope.audit.map((event) => (
                <div className="timeline-item" key={event.id}>
                  <div className={`timeline-dot${event.type.includes('signed') || event.type.includes('completed') ? ' ok' : ''}`}>
                    {event.type.split('.')[1]?.slice(0, 2).toUpperCase() ?? '•'}
                  </div>
                  <div className="timeline-body">
                    <div className="timeline-title">{EVENT_LABELS[event.type] ?? event.type}</div>
                    <div className="dim">
                      {formatDate(event.at)} · {event.actor}
                      {event.ip ? ` · ${event.ip}` : ''}
                    </div>
                    <div className="timeline-meta">{event.hash.slice(0, 32)}…</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
