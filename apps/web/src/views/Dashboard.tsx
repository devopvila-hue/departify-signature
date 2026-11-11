/** Dashboard: list of signature requests with progress and quick actions. */
import { useEffect, useMemo, useState } from 'react';
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
            <h1 style={{ fontSize: 26 }}>Solicitudes de firma</h1>
            <p className="muted" style={{ marginTop: 6 }}>
              Prepara documentos, define campos y controla el ciclo de firma con trazabilidad completa.
            </p>
          </div>
          <a className="btn btn-primary" href="#/new">
            Nueva solicitud
          </a>
        </div>

        <div className="grid grid-3">
          <div className="card card-pad">
            <div className="kpi">
              <span className="kpi-value">{stats.total}</span>
              <span className="kpi-label">Totales</span>
            </div>
          </div>
          <div className="card card-pad">
            <div className="kpi">
              <span className="kpi-value">{stats.pending}</span>
              <span className="kpi-label">En curso</span>
            </div>
          </div>
          <div className="card card-pad">
            <div className="kpi">
              <span className="kpi-value">{stats.completed}</span>
              <span className="kpi-label">Completadas</span>
            </div>
          </div>
        </div>

        {error && <div className="notice notice-error">{error}</div>}

        <div className="card">
          <div className="card-head">
            <span className="card-title">Todas las solicitudes</span>
            <button className="btn btn-sm" onClick={() => void load()} disabled={loading}>
              {loading ? 'Actualizando…' : 'Actualizar'}
            </button>
          </div>

          {loading && envelopes.length === 0 ? (
            <div className="empty">Cargando solicitudes…</div>
          ) : envelopes.length === 0 ? (
            <div className="empty">
              <h3>Todavía no hay solicitudes</h3>
              <p>Sube un PDF para crear tu primera solicitud de firma.</p>
              <div style={{ marginTop: 16 }}>
                <a className="btn btn-primary" href="#/new">
                  Crear solicitud
                </a>
              </div>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Documento</th>
                  <th>Estado</th>
                  <th>Firmantes</th>
                  <th>Nivel</th>
                  <th>Creada</th>
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
                        Abrir
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
