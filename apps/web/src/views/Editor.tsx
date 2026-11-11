/**
 * Editor: three steps to prepare a signature request.
 *
 *   1. Document  — upload a PDF and set the envelope metadata.
 *   2. People    — define signers and copy recipients.
 *   3. Fields    — click on the rendered pages to place signature fields.
 *
 * The flow mirrors the reference product but keeps the recipient model and
 * field placement in a single screen, which shortens the path to a sent
 * request.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FieldType } from '@signatureit/shared';
import { api, fileToBase64 } from '../api';
import { eventToPoint, loadPdf, renderPages, type RenderedPage } from '../pdf';
import { CanvasHost } from '../CanvasHost';

interface RecipientDraft {
  key: string;
  name: string;
  email: string;
  role: 'signer' | 'cc';
}

interface PlacedField {
  id: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  recipientKey?: string;
  label?: string;
  required: boolean;
}

const FIELD_TOOLS: Array<{ type: FieldType; label: string; icon: string; size: [number, number] }> = [
  { type: 'signature', label: 'Firma', icon: '✍', size: [180, 60] },
  { type: 'initials', label: 'Iniciales', icon: 'Id', size: [70, 34] },
  { type: 'text', label: 'Texto', icon: 'T', size: [170, 30] },
  { type: 'date', label: 'Fecha', icon: '📅', size: [110, 28] },
  { type: 'checkbox', label: 'Casilla', icon: '☑', size: [24, 24] },
];

export function Editor() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [signatureLevel, setSignatureLevel] = useState('simple');
  const [signingOrder, setSigningOrder] = useState('sequential');
  const [recipients, setRecipients] = useState<RecipientDraft[]>([
    { key: 'r1', name: '', email: '', role: 'signer' },
  ]);
  const [fields, setFields] = useState<PlacedField[]>([]);
  const [activeTool, setActiveTool] = useState<FieldType>('signature');
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ----------------------------- document step ---------------------------- */

  const onFile = async (selected: File | null) => {
    if (!selected) return;
    setError(null);
    if (selected.type !== 'application/pdf' && !selected.name.toLowerCase().endsWith('.pdf')) {
      setError('Selecciona un archivo PDF.');
      return;
    }
    setFile(selected);
    if (!title) setTitle(selected.name.replace(/\.pdf$/i, ''));
    setLoadingPdf(true);
    try {
      const pdf = await loadPdf(URL.createObjectURL(selected));
      setPages(await renderPages(pdf, 1.15));
    } catch {
      setError('No se pudo previsualizar el PDF. Comprueba que el archivo no esté dañado.');
      setPages([]);
    } finally {
      setLoadingPdf(false);
    }
  };

  /* ------------------------------ people step ----------------------------- */

  const updateRecipient = (key: string, patch: Partial<RecipientDraft>) => {
    setRecipients((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const addRecipient = () => {
    setRecipients((current) => [
      ...current,
      { key: `r${Date.now()}${current.length}`, name: '', email: '', role: 'signer' },
    ]);
  };

  const removeRecipient = (key: string) => {
    setRecipients((current) => current.filter((r) => r.key !== key));
  };

  /* ------------------------------ fields step ----------------------------- */

  const placeField = useCallback(
    (page: RenderedPage, event: React.MouseEvent<HTMLDivElement>) => {
      const tool = FIELD_TOOLS.find((t) => t.type === activeTool);
      if (!tool) return;
      const target = event.target as HTMLElement;
      if (target.closest('.placed-field')) return;
      const point = eventToPoint(page, event);
      const id = `f${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const width = Math.min(tool.size[0], page.pointWidth);
      const height = Math.min(tool.size[1], page.pointHeight);
      const x = Math.max(0, Math.min(point.x - width / 2, page.pointWidth - width));
      const y = Math.max(0, Math.min(point.y - height / 2, page.pointHeight - height));
      const firstSigner = recipients.find((r) => r.role === 'signer');
      setFields((current) => [
        ...current,
        {
          id,
          type: activeTool,
          page: page.number,
          x,
          y,
          width,
          height,
          recipientKey: firstSigner?.key,
          required: activeTool === 'signature',
        },
      ]);
      setActiveFieldId(id);
    },
    [activeTool, recipients],
  );

  const removeField = (id: string) => {
    setFields((current) => current.filter((f) => f.id !== id));
    if (activeFieldId === id) setActiveFieldId(null);
  };

  const moveField = (id: string, page: RenderedPage, event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const point = eventToPoint(page, event);
    setFields((current) =>
      current.map((field) =>
        field.id === id
          ? {
              ...field,
              x: Math.max(0, Math.min(point.x - field.width / 2, page.pointWidth - field.width)),
              y: Math.max(0, Math.min(point.y - field.height / 2, page.pointHeight - field.height)),
            }
          : field,
      ),
    );
  };

  /* -------------------------------- submit -------------------------------- */

  const canContinue =
    step === 1
      ? Boolean(file && title.trim())
      : step === 2
        ? recipients.some((r) => r.role === 'signer' && r.name.trim() && r.email.includes('@'))
        : fields.length > 0;

  const submit = async () => {
    if (!file) return;
    setSending(true);
    setError(null);
    try {
      const documentBase64 = await fileToBase64(file);
      const payload = {
        title: title.trim(),
        documentBase64,
        fileName: file.name,
        message: message.trim() || undefined,
        signatureLevel,
        signingOrder,
        recipients: recipients.map((r, index) => ({
          name: r.name.trim(),
          email: r.email.trim(),
          role: r.role,
          order: index + 1,
          ref: r.key,
        })),
        fields: fields.map((field) => ({
          id: field.id,
          type: field.type,
          label: field.label,
          required: field.required,
          recipientRef: field.recipientKey,
          placement: {
            page: field.page,
            x: Math.round(field.x),
            y: Math.round(field.y),
            width: Math.round(field.width),
            height: Math.round(field.height),
          },
        })),
      };
      const envelope = await api.createEnvelope(payload);
      await api.sendEnvelope(envelope.id);
      setCreatedId(envelope.id);
      setStep(3);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo crear la solicitud.');
    } finally {
      setSending(false);
    }
  };

  const signerCount = useMemo(() => recipients.filter((r) => r.role === 'signer').length, [recipients]);

  return (
    <main className="page page-wide">
      <div className="stack">
        <div className="row-between">
          <div>
            <h1 style={{ fontSize: 26 }}>Nueva solicitud de firma</h1>
            <p className="muted" style={{ marginTop: 6 }}>
              Sube el documento, indica quién firma y coloca los campos sobre las páginas.
            </p>
          </div>
          <a className="btn btn-ghost" href="#/">
            Volver
          </a>
        </div>

        <div className="row" style={{ gap: 8 }}>
          {[
            { n: 1, label: 'Documento' },
            { n: 2, label: 'Destinatarios' },
            { n: 3, label: 'Campos' },
          ].map((item) => (
            <div
              key={item.n}
              className="badge"
              style={
                step === item.n
                  ? { background: 'var(--gradient-brand)', color: '#fff', borderColor: 'transparent' }
                  : undefined
              }
            >
              {item.n}. {item.label}
            </div>
          ))}
        </div>

        {error && <div className="notice notice-error">{error}</div>}
        {createdId && (
          <div className="notice notice-success">
            Solicitud creada y enviada. <a href={`#/envelopes/${createdId}`}>Ver detalle</a>
          </div>
        )}

        {step === 1 && (
          <div className="grid grid-sidebar">
            <div className="card">
              <div className="card-head">
                <span className="card-title">Documento</span>
              </div>
              <div className="card-body stack">
                <div className="field">
                  <span className="label">Archivo PDF</span>
                  <input
                    ref={fileInputRef}
                    className="input"
                    type="file"
                    accept="application/pdf,.pdf"
                    onChange={(event) => void onFile(event.target.files?.[0] ?? null)}
                  />
                  {file && (
                    <span className="dim">
                      {file.name} · {(file.size / 1024).toFixed(0)} KB · {pages.length} páginas
                    </span>
                  )}
                </div>

                <div className="field">
                  <span className="label">Título</span>
                  <input
                    className="input"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="Contrato de servicios 2026"
                  />
                </div>

                <div className="field">
                  <span className="label">Mensaje para los firmantes</span>
                  <textarea
                    className="textarea"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="Explica brevemente el motivo de la firma."
                  />
                </div>

                <div className="grid grid-2">
                  <div className="field">
                    <span className="label">Nivel de firma</span>
                    <select
                      className="select"
                      value={signatureLevel}
                      onChange={(event) => setSignatureLevel(event.target.value)}
                    >
                      <option value="simple">Simple</option>
                      <option value="simple_otp">Simple con OTP</option>
                      <option value="advanced">Avanzada (certificado)</option>
                      <option value="qualified">Cualificada</option>
                    </select>
                  </div>
                  <div className="field">
                    <span className="label">Orden de firma</span>
                    <select
                      className="select"
                      value={signingOrder}
                      onChange={(event) => setSigningOrder(event.target.value)}
                    >
                      <option value="sequential">Secuencial</option>
                      <option value="parallel">Paralelo</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <span className="card-title">Vista previa</span>
              </div>
              <div className="card-body">
                {loadingPdf ? (
                  <div className="empty">Renderizando documento…</div>
                ) : pages.length === 0 ? (
                  <div className="empty">
                    <h3>Aún no hay documento</h3>
                    <p>Al subir el PDF verás aquí la previsualización.</p>
                  </div>
                ) : (
                  <div className="dim">
                    {pages.length} página{pages.length === 1 ? '' : 's'} lista
                    {pages.length === 1 ? '' : 's'} para colocar campos.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="card">
            <div className="card-head">
              <span className="card-title">Destinatarios</span>
              <button className="btn btn-sm" onClick={addRecipient}>
                Añadir destinatario
              </button>
            </div>
            <div className="card-body stack">
              {recipients.map((recipient, index) => (
                <div className="card card-pad" key={recipient.key}>
                  <div className="row-between" style={{ marginBottom: 12 }}>
                    <strong>{recipient.role === 'signer' ? `Firmante ${index + 1}` : `Copia ${index + 1}`}</strong>
                    <div className="row">
                      <select
                        className="select"
                        style={{ width: 180 }}
                        value={recipient.role}
                        onChange={(event) =>
                          updateRecipient(recipient.key, {
                            role: event.target.value as 'signer' | 'cc',
                          })
                        }
                      >
                        <option value="signer">Firmante</option>
                        <option value="cc">Solo copia</option>
                      </select>
                      {recipients.length > 1 && (
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => removeRecipient(recipient.key)}
                        >
                          Quitar
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-2">
                    <div className="field">
                      <span className="label">Nombre</span>
                      <input
                        className="input"
                        value={recipient.name}
                        onChange={(event) =>
                          updateRecipient(recipient.key, { name: event.target.value })
                        }
                        placeholder="Nombre y apellidos"
                      />
                    </div>
                    <div className="field">
                      <span className="label">Correo</span>
                      <input
                        className="input"
                        type="email"
                        value={recipient.email}
                        onChange={(event) =>
                          updateRecipient(recipient.key, { email: event.target.value })
                        }
                        placeholder="nombre@empresa.com"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="editor-layout">
            <div className="stack">
              <div className="card">
                <div className="card-head">
                  <span className="card-title">Herramientas</span>
                </div>
                <div className="card-body">
                  <div className="field-tool">
                    {FIELD_TOOLS.map((tool) => (
                      <button
                        key={tool.type}
                        className={`field-tool-btn${activeTool === tool.type ? ' active' : ''}`}
                        onClick={() => setActiveTool(tool.type)}
                      >
                        <span className="field-tool-icon">{tool.icon}</span>
                        {tool.label}
                      </button>
                    ))}
                  </div>
                  <p className="dim" style={{ marginTop: 14 }}>
                    Haz clic sobre el documento para colocar el campo seleccionado. Arrastra un campo
                    para recolocarlo.
                  </p>
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <span className="card-title">Campos ({fields.length})</span>
                </div>
                <div className="card-body stack" style={{ gap: 8 }}>
                  {fields.length === 0 && <div className="dim">Todavía no hay campos.</div>}
                  {fields.map((field) => (
                    <div
                      key={field.id}
                      className="stack"
                      style={{
                        gap: 8,
                        padding: '10px',
                        border: '1px solid var(--line-1)',
                        borderRadius: 'var(--radius-md)',
                        background:
                          activeFieldId === field.id ? 'var(--success-soft)' : 'var(--surface-1)',
                      }}
                    >
                      <div className="row">
                        <span className="badge">{field.type}</span>
                        <span className="dim grow">
                          p.{field.page} · {Math.round(field.width)}×{Math.round(field.height)} pt
                        </span>
                        <button className="btn btn-sm btn-ghost" onClick={() => removeField(field.id)}>
                          ✕
                        </button>
                      </div>
                      <div className="row">
                        <select
                          className="select"
                          style={{ padding: '5px 8px', fontSize: 12.5 }}
                          value={field.recipientKey ?? ''}
                          onChange={(event) =>
                            setFields((current) =>
                              current.map((candidate) =>
                                candidate.id === field.id
                                  ? { ...candidate, recipientKey: event.target.value || undefined }
                                  : candidate,
                              ),
                            )
                          }
                        >
                          <option value="">Todos los firmantes</option>
                          {recipients
                            .filter((recipient) => recipient.role === 'signer')
                            .map((recipient, index) => (
                              <option key={recipient.key} value={recipient.key}>
                                {recipient.name || `Firmante ${index + 1}`}
                              </option>
                            ))}
                        </select>
                        <label className="checkbox-row" style={{ fontSize: 12.5 }}>
                          <input
                            type="checkbox"
                            checked={field.required}
                            onChange={(event) =>
                              setFields((current) =>
                                current.map((candidate) =>
                                  candidate.id === field.id
                                    ? { ...candidate, required: event.target.checked }
                                    : candidate,
                                ),
                              )
                            }
                          />
                          Obligatorio
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="pdf-stage">
              {pages.map((page) => (
                <div
                  key={page.number}
                  className="pdf-page"
                  style={{ width: page.width, height: page.height }}
                  onClick={(event) => placeField(page, event)}
                >
                  <CanvasHost canvas={page.canvas} />
                  {fields
                    .filter((field) => field.page === page.number)
                    .map((field) => (
                      <div
                        key={field.id}
                        className={`placed-field ${field.type}${activeFieldId === field.id ? ' active' : ''}`}
                        style={{
                          left: `${(field.x / page.pointWidth) * 100}%`,
                          top: `${(field.y / page.pointHeight) * 100}%`,
                          width: `${(field.width / page.pointWidth) * 100}%`,
                          height: `${(field.height / page.pointHeight) * 100}%`,
                        }}
                        onMouseDown={(event) => moveField(field.id, page, event)}
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={() => removeField(field.id)}
                      >
                        {field.type}
                      </div>
                    ))}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="row-between">
          <div className="row">
            {step > 1 && (
              <button className="btn" onClick={() => setStep((step - 1) as 1 | 2 | 3)}>
                Atrás
              </button>
            )}
          </div>
          <div className="row">
            {step < 3 ? (
              <button
                className="btn btn-primary"
                disabled={!canContinue}
                onClick={() => setStep((step + 1) as 1 | 2 | 3)}
              >
                Continuar
              </button>
            ) : (
              <button className="btn btn-primary" disabled={!canContinue || sending} onClick={() => void submit()}>
                {sending ? 'Enviando…' : 'Crear y enviar'}
              </button>
            )}
          </div>
        </div>

        {step === 2 && signerCount === 0 && (
          <div className="notice notice-warning">Añade al menos un firmante.</div>
        )}
      </div>
    </main>
  );
}
