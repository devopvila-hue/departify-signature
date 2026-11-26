/**
 * Signature — i18n de la interfaz.
 *
 * Alcance deliberado: SOLO se traduce la interfaz (dashboard, editor, visor,
 * flujo de firma, mensajes del sistema). NUNCA se tocan documentos, firmas,
 * evidencias criptográficas, hashes, identificadores de auditoría ni contenido
 * aportado por el cliente: esos valores se muestran tal cual se firmaron.
 *
 * Contrato global de Departify: el portal es el dueño del idioma y lo anuncia
 * por `?lang=` y por `departify:locale`. Sólo se acepta el frame padre y su
 * origen; nunca "*"; ningún token viaja en el mensaje.
 *
 * El español es la fuente: la clave es el texto español, así que una cadena
 * sin traducir se lee en español y jamás aparece como clave cruda.
 */
import es from './locales/es.json' with { type: 'json' };
import en from './locales/en.json' with { type: 'json' };
import ro from './locales/ro.json' with { type: 'json' };
import hu from './locales/hu.json' with { type: 'json' };

export const LANGS = ['es', 'en', 'ro', 'hu'] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = 'es';
const STORAGE_KEY = 'departify-signature:lang';

const DICTS: Record<Lang, Record<string, string>> = { es, en, ro, hu };
let current: Lang = DEFAULT_LANG;

export function getLang(): Lang {
  return current;
}

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

/** El `?lang=` que el portal pone en la URL del iframe, si es válido. */
export function langFromSearch(search: string): Lang | null {
  try {
    const value = new URLSearchParams(search).get('lang');
    return isLang(value) ? value : null;
  } catch {
    return null;
  }
}

/** Activa un idioma y lo recuerda. Devuelve el idioma efectivo. */
export function setLang(lang: unknown): Lang {
  const next = isLang(lang) ? lang : DEFAULT_LANG;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* modo privado: dura la sesión */
  }
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  return next;
}

/** Idioma inicial: el del portal → el guardado → el del navegador → español. */
export function initLang(): Lang {
  const fromPortal = langFromSearch(window.location.search);
  if (fromPortal) return setLang(fromPortal);
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  if (isLang(stored)) return setLang(stored);
  const nav = String(navigator.language || '').slice(0, 2).toLowerCase();
  return setLang(isLang(nav) ? nav : DEFAULT_LANG);
}

/**
 * Traduce una clave. `vars` rellena los `{placeholders}`.
 * Una clave desconocida devuelve el texto español original.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  let text = DICTS[current]?.[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

const listeners = new Set<(lang: Lang) => void>();
export function onLangChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Escucha los cambios que el portal anuncia y repinta sin recargar.
 * Sólo el frame padre y su origen; nunca "*".
 */
export function listenToPortalLocale(): () => void {
  const parent = typeof window === 'undefined' ? null : window.parent;
  if (!parent || parent === window) return () => {};
  const origins = new Set<string>(['https://app.departify.app']);
  try {
    const ancestor = window.location.ancestorOrigins?.[0];
    if (ancestor && ancestor !== 'null') origins.add(ancestor);
  } catch {
    /* sin ancestorOrigins: queda el origen configurado */
  }
  const onMessage = (event: MessageEvent) => {
    if (!origins.has(event.origin)) return;
    if (event.source !== parent) return;
    const data = event.data as { type?: unknown; version?: unknown; locale?: unknown } | null;
    if (!data || typeof data !== 'object' || data.type !== 'departify:locale') return;
    if (data.version !== 1) return;
    if (!isLang(data.locale) || data.locale === current) return;
    setLang(data.locale);
    for (const fn of listeners) fn(current);
  };
  window.addEventListener('message', onMessage);
  for (const origin of origins) parent.postMessage({ type: 'departify:locale-request', version: 1 }, origin);
  return () => window.removeEventListener('message', onMessage);
}
