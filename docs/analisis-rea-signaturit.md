# Análisis REA de Signaturit y decisiones de diseño

Este documento recoge la investigación realizada con **REA** sobre el sitio
público de Signaturit y explica, evidencia a evidencia, de dónde sale cada
decisión de `DEPARTIFY Signature`.

El objetivo no era copiar el producto, sino entender su modelo de dominio
(qué es una solicitud de firma, qué niveles de garantía existen, qué campos
se pueden colocar, cómo se demuestra la evidencia) para construir una versión
local, más auditable y con una API pensada para integrarse en el CRM.

---

## 1. Alcance y método

Se analizaron únicamente páginas públicas del dominio `www.signaturit.com`,
sin autenticación, sin credenciales y sin interacción con cuentas reales.

| Paso | Herramienta REA | Evidencia |
| ---- | ---------------- | --------- |
| Localizar objetivos de página | `list_browser_targets` | `ev_2922c21b8d803105dd077d29e8872ce2ec876a3c46b280581891883b460a18d0` |
| Inspeccionar la home (DOM, scripts, red) | `inspect_web_page` | `ev_04283141a37fdc5a47e888294c98bf0772587fa7b3192546e3b8da6c1d8c021f` |
| Inspeccionar la página de firma electrónica (accesibilidad + fuentes JS) | `inspect_web_page` | `ev_d01600174e112e20121e9da8b3a687c2f7d2c6f47498636357a4a1f769c865f2` |
| Exportar los scripts capturados | `export_web_scripts` | `ev_9411e007a2026aa2d76fd85b1f79fcf86b772f1bf1cf92bc3e9a8363d32c3a02` |
| Reconstrucción estática de la aplicación JS | `analyze_javascript_application` | `ev_84a38947eefb4ddb6642431a501925059f2ea2074ae12766da6dba4edd32cf41` |

### Límites de la investigación

- El análisis es **estático**. Reconstructir el grafo de la aplicación no
  demuestra que nada se ejecute en tiempo de ejecución.
- La aplicación web que usa el producto (la que sirve los documentos a los
  firmantes) está detrás de autenticación y **no se ha analizado**.
- El código capturado es el tema público de marketing (WordPress), no la
  lógica de negocio del producto: 2 ficheros, 3 840 nodos AST, 0 módulos ESM
  resueltos. Sirvió para confirmar la superficie de navegación, no para
  reconstruir el motor de firma.
- Las conclusiones sobre el flujo de producto provienen de la **accesibilidad
  y el texto** de las páginas públicas, no de su código.

---

## 2. Lo que se observó

### 2.1 Los cuatro niveles de garantía

De `ev_d01600174e112e20121e9da8b3a687c2f7d2c6f47498636357a4a1f769c865f2`
(169 textos únicos de accesibilidad), el producto expone una escalera de
garantía explícita:

| Nivel | Texto observado | Qué exige |
| ----- | --------------- | --------- |
| Simple | "signing with a click" | "despite having probative value, it does not allow the signatory to be uniquely identified" |
| Simple + OTP | "unique code received by SMS" | "the integrity of the document is assured and the identity of the signatory is confirmed unequivocally" |
| Advanced | "signs with their digital certificate" | "the only means of technically and legally guaranteeing a person's identity on the Internet" |
| Qualified | "qualified electronic certificate... issued by an accredited provider" | "the highest level of legal certainty" |

**Decisión.** `packages/shared/src/index.ts` modela los cuatro niveles con
`SIGNATURE_LEVELS` y sus notas legales, de modo que el contrato no cambia
cuando se añada un proveedor de confianza. Los dos niveles ejecutables en
local son `simple` y `simple_otp`; los otros dos se declaran con su
semántica legal pero sin prometer un certificado que este repositorio no
puede emitir.

### 2.2 El flujo de trabajo

Los cuatro pasos que la página de producto describe:

1. "Configure and send your document" — se sube el documento y se envía.
2. "Sign from anywhere" — con móvil y código QR.
3. "Keep track easily" — seguimiento del estado.
4. "Securely archived" — archivo.

**Decisión.** Se implementan los cuatro pasos en la interfaz: el editor cubre
(1), la sala de firma cubre (2), el panel de detalle con firmantes y estado
cubre (3), y la persistencia local con hash encadenado cubre (4).

### 2.3 Los tipos de campo

Del texto de precios (misma captura) se extrae la lista completa de campos que
el producto permite colocar sobre el documento:

- texto ("Add text to the PDF prepared for signing")
- casillas ("Add checkboxes to the PDF prepared for signing")
- botones de opción ("Add radio buttons to the PDF prepared for signing")
- menús desplegables ("Add dropdown menus in the PDF prepared for signing")
- texto automático con datos del firmante ("signing date, email address,
  name, job title, or company of the signer")
- imagen subida por el firmante ("Ask signers to upload an image directly")
- iniciales ("Ask your signers to initial the documents")
- consentimiento personalizable ("Customize the consents text before signature")
- documentos adjuntos del firmante ("Ask the signer to add supporting
  documents")

**Decisión.** Se implementan firma, iniciales, texto, fecha, casilla y
desplegable, con etiqueta, obligatoriedad y asignación por firmante. El
"texto automático con datos del firmante" y los adjuntos quedan fuera del
primer alcance, pero el modelo de datos (campo con `options`, `placeholder` y
`recipientId`) ya los admite sin migración.

### 2.4 El modelo de destinatarios

Observado en precios: "Recipients in copy", "Alternate signer" y "Don't know
the final signer? Allow a third party to provide the signer's information",
además de "7 different user roles".

**Decisión.** El rol del destinatario se reduce a `signer` y `cc`, que es lo
que necesita un CRM para distinguir "firma" de "recibido". El firmante
alternativo y el firmante indicado por un tercero no se implementan: exigen
un motor de reglas que no aporta nada a la integración y multiplica los casos
de prueba.

### 2.5 La evidencia

El producto muestra "Electronic signature completed with audit trail" y
"Archiving signed documents securely".

**Decisión — la diferencia principal.** En lugar de un registro de auditoría
consultable, la implementación encadena los eventos con SHA-256: cada evento
guarda el hash del anterior. Alterar o borrar un evento invalida todos los
posteriores, y `GET /api/envelopes/:id/audit/verify` recalcula la cadena
completa y devuelve el punto exacto de rotura. El PDF firmado incorpora una
página de certificado con el hash del documento original, los firmantes, el
nivel de garantía y la cola de la cadena.

Es una mejora verificable sin confianza: cualquier tercero puede recomputar
los hashes con los mismos datos y obtener el mismo resultado.

---

## 3. Mapa de superficie del sitio

Extraído del grafo de enlaces de la home (`ev_04283141...`): 107 enlaces
internos y 10 dominios externos.

```
www.signaturit.com
├── products/signature/signaturit/          ← página analizada
│   ├── electronic-signature-pdf/
│   └── free/
├── products/digital-identity/              id-verification, wallet, verifiable-credentials
├── products/authentication/                certificates-creation, certificates-management
├── products/certified-comunications/       sms, email
├── products/egovernment/e-notifications/
├── document-check/                         products/digital-preservation/
├── products/integrations/api/
├── industries/…  use-cases/…  partners/…  resources/…
└── account.signaturit.com                  (requiere autenticación → no analizado)
```

El producto es mucho más amplio que la firma: verificación de identidad,
creación y gestión de certificados, comunicaciones certificadas y preservación
digital. **Decisión.** Este repositorio cubre solo el núcleo de firma
electrónica, que es la pieza que DEPARTIFY necesita para cerrar contratos con
sus clientes. El resto queda fuera a propósito: son líneas de producto
separadas, no una ampliación del flujo de firma.

---

## 4. Lo que este repositorio improve

| Área | Signaturit (observado) | DEPARTIFY Signature |
| ---- | ---------------------- | -------------------- |
| Evidencia | Registro de auditoría consultable | Cadena de hashes SHA-256 verificable, con punto de rotura |
| Entrega | Correo/SMS con proveedor | API REST + enlace con token; el OTP se entrega por el canal que se configure |
| Integración | API de producto con partners | Contrato `@signatureit/shared` pensado para el CRM, con `metadata` libre |
| Despliegue | SaaS multi-tenant | Local, sin servicios externos ni Docker |
| Dependencias | Producto cerrado | `node:sqlite` + `pdf-lib`: sin compilación nativa ni CDN |
| Certificado | Generado por el proveedor | Generado localmente con los hashes del documento y de la cadena |

---

## 5. Reproducir el análisis

```bash
# 1. Levantar un Chrome con CDP en loopback
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9333 \
  --user-data-dir=/tmp/rea-signaturit-profile about:blank &

# 2. Abrir la página de producto
curl -X PUT "http://127.0.0.1:9333/json/new?https://www.signaturit.com/products/signature/signaturit/"

# 3. Capturar con REA
rea inspect-web-page http://127.0.0.1:9333 <targetId> \
  --observation-ms 1500 --include-accessibility-text --include-script-sources \
  --format json > capture.json

# 4. Exportar y reconstruir los scripts
rea export-web-scripts $PWD/capture.json $PWD/scripts_export --format json
rea analyze-javascript-application $PWD/scripts_export/files \
  --artifact-format directory --format json
```

Las capturas y el grafo semántico completos están en `analysis/rea/`
(los volcados brutos están excluidos de Git por tamaño).
