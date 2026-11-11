/**
 * Signing room: the recipient-facing screen.
 *
 * It shows the document, the fields the recipient must complete, a signature
 * pad, the OTP challenge when the envelope requires it, and the consent
 * checkbox before signing.
 */
import { useEffect, useRef, useState } from 'react';
import type { SigningRoomPayload } from '@signatureit/shared';
import { api, ApiError } from '../api';
import { loadPdf, renderPages, type RenderedPage } from '../pdf';
import { CanvasHost } from '../CanvasHost';
import { formatDate } from '../ui';

export function SigningRoom({ token }: { token: string }) {
  const [room, setRoom] = useState<SigningRoomPayload | null>(null);
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [signatureData, setSignatureData] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);

  /* ------------------------------- loading -------------------------------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await api.getSigningRoom(token);
        if (cancelled) return;
        setRoom(payload);
        const pdf = await loadPdf(payload.documentUrl);
        const rendered = await renderPages(pdf, 1.1);
        if (!cancelled) setPages(rendered);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'No se pudo abrir la solicitud.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  /* ---------------------------- signature pad ----------------------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = 520;
    const height = 170;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(ratio, ratio);
    context.lineWidth = 2.4;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#14191a';
  }, [room]);

  const canvasPoint = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const startDrawing = (event: React.MouseEvent<HTMLCanvasElement>) => {
    drawing.current = true;
    lastPoint.current = canvasPoint(event);
  };

  const draw = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const context = canvasRef.current?.getContext('2d');
    if (!context || !lastPoint.current) return;
    const point = canvasPoint(event);
    context.beginPath();
    context.moveTo(lastPoint.current.x, lastPoint.current.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    lastPoint.current = point;
  };

  const stopDrawing = () => {
    drawing.current = false;
    lastPoint.current = null;
    if (canvasRef.current) {
      setSignatureData(canvasRef.current.toDataURL('image/png'));
    }
  };

  const clearSignature = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (canvas && context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
    setSignatureData(null);
  };

  /* -------------------------------- actions ------------------------------- */

  const requestOtp = async () => {
    setError(null);
    try {
      const result = await api.requestOtp(token);
      setOtpSent(result.code ?? 'Código enviado');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo enviar el código.');
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const payloadValues: Record<string, string | boolean> = { ...values };
      await api.sign(token, {
        values: payloadValues,
        signatureImage: signatureData ?? undefined,
        otp: otp || undefined,
        consentAccepted: consent,
      });
      setDone(true);
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'No se pudo firmar.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const decline = async () => {
    setSubmitting(true);
    try {
      await api.decline(token, 'El firmante ha rechazado la solicitud.');
      setDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo registrar el rechazo.');
    } finally {
      setSubmitting(false);
    }
  };

  /* -------------------------------- render -------------------------------- */

  if (done) {
    return (
      <div className="sign-shell">
        <div className="sign-card">
          <div className="sign-head">
            <h1 style={{ fontSize: 22 }}>Firma registrada</h1>
            <p className="muted" style={{ marginTop: 8 }}>
              El documento se ha firmado correctamente y la evidencia ha quedado registrada en el
              registro de auditoría.
            </p>
          </div>
          <div className="sign-body">
            <div className="notice notice-success">
              Gracias. Puedes cerrar esta ventana. Si el documento requería más firmantes, el
              solicitante ya ha sido notificado.
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error && !room) {
    return (
      <div className="sign-shell">
        <div className="sign-card">
          <div className="sign-head">
            <h1 style={{ fontSize: 20 }}>No se puede abrir la solicitud</h1>
          </div>
          <div className="sign-body">
            <div className="notice notice-error">{error}</div>
          </div>
        </div>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="sign-shell">
        <div className="sign-card">
          <div className="sign-body">
            <div className="empty">Cargando documento…</div>
          </div>
        </div>
      </div>
    );
  }

  const signatureFields = room.fields.filter((field) => field.type === 'signature');
  const needsSignature = signatureFields.length > 0 && !signatureData;

  return (
    <div className="sign-shell">
      <div className="sign-card">
        <div className="sign-head">
          <div className="row-between">
            <div>
              <span className="badge badge-sent">Firma {room.signatureLevel.replace('_', ' ')}</span>
              <h1 style={{ fontSize: 22, marginTop: 10 }}>{room.title}</h1>
              {room.message && (
                <p className="muted" style={{ marginTop: 8 }}>
                  {room.message}
                </p>
              )}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="dim">Firmante</div>
              <div style={{ fontWeight: 650 }}>{room.recipient.name}</div>
              <div className="dim">{room.recipient.email}</div>
            </div>
          </div>
        </div>

        <div className="sign-body">
          {error && <div className="notice notice-error">{error}</div>}

          {room.expiresAt && (
            <div className="notice notice-info">
              Esta solicitud caduca el {formatDate(room.expiresAt)}.
            </div>
          )}

          <div className="sign-pdf">
            {pages.length === 0 ? (
              <div className="dim">Cargando páginas…</div>
            ) : (
              pages.map((page) => (
                <div
                  key={page.number}
                  className="pdf-page"
                  style={{ width: page.width, height: page.height }}
                >
                  <CanvasHost canvas={page.canvas} />
                  {room.fields
                    .filter((field) => field.page === page.number)
                    .map((field) => (
                      <div
                        key={field.id}
                        className={`placed-field ${field.type}`}
                        style={{
                          left: `${(field.x / page.pointWidth) * 100}%`,
                          top: `${(field.y / page.pointHeight) * 100}%`,
                          width: `${(field.width / page.pointWidth) * 100}%`,
                          height: `${(field.height / page.pointHeight) * 100}%`,
                        }}
                      >
                        {field.value ? '✓' : field.label ?? field.type}
                      </div>
                    ))}
                </div>
              ))
            )}
          </div>

          {room.fields.some((field) => field.type === 'text' || field.type === 'date') && (
            <div className="stack" style={{ gap: 12 }}>
              {room.fields
                .filter((field) => field.type === 'text' || field.type === 'date')
                .map((field) => (
                  <div className="field" key={field.id}>
                    <span className="label">
                      {field.label ?? (field.type === 'date' ? 'Fecha' : 'Texto')}
                      {field.required ? ' *' : ''}
                    </span>
                    <input
                      className="input"
                      type={field.type === 'date' ? 'date' : 'text'}
                      value={typeof values[field.id] === 'string' ? (values[field.id] as string) : ''}
                      placeholder={field.placeholder}
                      onChange={(event) =>
                        setValues((current) => ({ ...current, [field.id]: event.target.value }))
                      }
                    />
                  </div>
                ))}
            </div>
          )}

          {signatureFields.length > 0 && (
            <div className="stack" style={{ gap: 10 }}>
              <span className="label">Firma del firmante *</span>
              <div className="signature-pad">
                <canvas
                  ref={canvasRef}
                  onMouseDown={startDrawing}
                  onMouseMove={draw}
                  onMouseUp={stopDrawing}
                  onMouseLeave={stopDrawing}
                />
                {!signatureData && <div className="signature-pad-hint">Firma aquí con el ratón</div>}
              </div>
              <div className="row">
                <button className="btn btn-sm" onClick={clearSignature} disabled={!signatureData}>
                  Limpiar
                </button>
                {signatureData && (
                  <div className="signature-preview">
                    <img src={signatureData} alt="Vista previa de la firma" />
                  </div>
                )}
              </div>
            </div>
          )}

          {room.requiresOtp && (
            <div className="stack" style={{ gap: 10 }}>
              <span className="label">Código de verificación *</span>
              <div className="row">
                <input
                  className="input"
                  style={{ maxWidth: 220 }}
                  value={otp}
                  onChange={(event) => setOtp(event.target.value)}
                  placeholder="6 dígitos"
                  inputMode="numeric"
                />
                <button className="btn" onClick={() => void requestOtp()}>
                  {otpSent ? 'Reenviar código' : 'Solicitar código'}
                </button>
              </div>
              {otpSent && (
                <div className="notice notice-info">
                  En una instalación autoalojada el código se envía por SMS o correo. En local se
                  muestra aquí: <strong>{otpSent}</strong>
                </div>
              )}
            </div>
          )}

          <label className="checkbox-row">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>{room.consentText}</span>
          </label>

          <div className="row" style={{ justifyContent: 'space-between' }}>
            <button className="btn btn-danger" onClick={() => void decline()} disabled={submitting}>
              Rechazar
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void submit()}
              disabled={submitting || !consent || needsSignature || (room.requiresOtp && !otp)}
            >
              {submitting ? 'Firmando…' : 'Firmar documento'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
