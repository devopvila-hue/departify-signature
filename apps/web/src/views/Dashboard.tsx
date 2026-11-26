/** Dashboard: list of signature requests with progress and quick actions. */
import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n';
import type { EnvelopeSummary } from '@signatureit/shared';
import { api } from '../api';
import { StatusBadge, formatDate } from '../ui';

export function Dashboard() {
  const [envelopes, setEnvelopes] = useState<EnvelopeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setEnvelopes(await api.listEnvelopes());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudieron cargar las solicitudes.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const stats = useMemo(
    () => ({
      total: envelopes.length,
      pending: envelopes.filter((e) => e.status === 'sent' || e.status === 'partially_signed').length,
      completed: envelopes.filter((e) => e.status === 'completed').length,
    }),
    [envelopes],
  );

  return (
    <main className="page">
      <div className="stack">
        <div className="row-between">
          <div>
            <h1 style={{ fontSize: 26 }}>{t("Solicitudes de firma")}</h1>
            <p className="muted" style={{ marginTop: 6 }}>
              Prepara documentos, define campos y controla el ciclo de firma con trazabilidad completa.
            </p>
          </div>
          <a className="btn btn-primary" href="#/new">
            {t("Nueva solicitud")}
          </a>
        </div>

        <div className="grid grid-3">
          <div className="card card-pad">
            <div className="kpi">
              <span className="kpi-value">{stats.total}</span>
              <span className="kpi-label">{t("Totales")}</span>
            </div>
          </div>
          <div className="card card-pad">
            <div className="kpi">
              <span className="kpi-value">{stats.pending}</span>
              <span className="kpi-label">{t("En curso")}</span>
            </div>
          </div>
          <div className="card card-pad">
            <div className="kpi">
              <span className="kpi-value">{stats.completed}</span>
              <span className="kpi-label">{t("Completadas")}</span>
            </div>
          </div>
        </div>

        {error && <div className="notice notice-error">{error}</div>}

        <div className="card">
          <div className="card-head">
            <span className="card-title">{t("Todas las solicitudes")}</span>
            <button className="btn btn-sm" onClick={() => void load()} disabled={loading}>
              {loading ? 'Actualizando…' : 'Actualizar'}
            </button>
          </div>

          {loading && envelopes.length === 0 ? (
            <div className="empty">{t("Cargando solicitudes…")}</div>
          ) : envelopes.length === 0 ? (
            <div className="empty">
              <h3>{t("Todavía no hay solicitudes")}</h3>
              <p>{t("Sube un PDF para crear tu primera solicitud de firma.")}</p>
              <div style={{ marginTop: 16 }}>
                <a className="btn btn-primary" href="#/new">
                  {t("Crear solicitud")}
                </a>
              </div>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t("Documento")}</th>
                  <th>{t("Estado")}</th>
                  <th>{t("Firmantes")}</th>
                  <th>{t("Nivel")}</th>
                  <th>{t("Creada")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {envelopes.map((envelope) => (
                  <tr key={envelope.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{envelope.title}</div>
                      <div className="dim mono">{envelope.fileName}</div>
                    </td>
                    <td>
                      <StatusBadge status={envelope.status} />
                    </td>
                    <td>
                      <span className="mono">
                        {envelope.signedRecipients}/{envelope.totalRecipients}
                      </span>
                    </td>
                    <td className="dim">{envelope.signatureLevel.replace('_', ' ')}</td>
                    <td className="dim">{formatDate(envelope.createdAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <a className="btn btn-sm" href={`#/envelopes/${envelope.id}`}>
                        {t("Abrir")}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </main>
  );
}
