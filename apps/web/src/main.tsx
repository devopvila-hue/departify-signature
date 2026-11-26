import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initLang, listenToPortalLocale } from './i18n';
import './styles.css';

/* El portal es el dueño del idioma: `?lang=` al cargar y `departify:locale`
   después. Sólo se traduce la interfaz; documentos y firmas no se tocan. */
initLang();
listenToPortalLocale();

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
