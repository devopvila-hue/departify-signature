# DEPARTIFY Signature

Firma electrónica local, auditable y lista para integrarse en DEPARTIFY.

Sube un PDF, define quién firma, coloca los campos sobre las páginas y envía.
El firmante abre un enlace, firma con el ratón o con el dedo y el sistema genera
el PDF firmado con una página de certificado encadenada.

Todo funciona en local: **sin servicios externos, sin VPS, sin Docker y sin
dependencias nativas de compilación**.

---

## Puesta en marcha

```bash
pnpm install          # instala dependencias (pnpm 9+)
pnpm build            # compila el cliente web
pnpm start            # levanta el servidor en http://127.0.0.1:4310
```

Durante el desarrollo puedes usar el modo watch:

```bash
pnpm dev              # API en :4310 y cliente Vite en :5310
```

Variables de entorno opcionales:

| Variable               | Por defecto          | Descripción                              |
| ---------------------- | -------------------- | ---------------------------------------- |
| `PORT`                 | `4310`               | Puerto de la API                         |
| `HOST`                 | `127.0.0.1`          | Interfaz de escucha                      |
| `SIGNATUREIT_DATA_DIR` | `packages/server/data` | Base de datos y documentos firmados    |
| `LOG_LEVEL`            | `info`               | `silent` desactiva el log del servidor   |

El estado local (base de datos, documentos y firmas) vive en
`packages/server/data/` y está excluido de Git.

---

## Cómo funciona

### 1. Preparar la solicitud

El remitente sube un PDF, elige el nivel de firma, añade firmantes y copias, y
coloca los campos haciendo clic sobre la página renderizada.

Tipos de campo disponibles: **firma**, **iniciales**, **texto**, **fecha**,
**casilla** y **desplegable**. Cada campo puede asignarse a un firmante
concreto y marcarse como obligatorio.

### 2. Firmar

Cada firmante recibe un enlace propio (`/sign/<token>`) con un token aleatorio
de 192 bits. La sala de firma solo expone los campos de ese firmante: nunca se
filtran los datos de los demás.

La firma se dibuja en un canvas y se incrusta en el PDF original. Los niveles
de firma disponibles:

| Nivel            | Qué exige al firmante                                  |
| ---------------- | ------------------------------------------------------- |
| `simple`         | Solo consentimiento y firma                             |
| `simple_otp`     | Además un código de un solo uso (SMS o correo)          |
| `advanced`       | Firma con certificado (declarado en el contrato)        |
| `qualified`      | Certificado cualificado (declarado en el contrato)      |

El orden de firma puede ser **secuencial** (cada firmante espera al anterior)
o **paralelo**.

### 3. Evidencia

Cada evento (creación, envío, apertura, verificación OTP, campo completado,
firma, rechazo, finalización) se guarda con:

- marca de tiempo ISO,
- actor (correo del firmante o `system`),
- IP y agente de usuario cuando se conocen,
- **hash SHA-256 encadenado**: cada evento incluye el hash del anterior, así que
  alterar o borrar un evento invalida todos los que le siguen.

El PDF firmado incluye una página de certificado con el hash del documento
original, los firmantes, el nivel de garantía y el registro de auditoría.

El endpoint `GET /api/envelopes/:id/audit/verify` recalcula la cadena y
devuelve el primer evento que no cuadra.

---

## Arquitectura

```
signatureit/
├── packages/
│   ├── shared/          # contrato único: tipos, esquemas zod, rutas de la API
│   └── server/          # API Fastify + SQLite + motor PDF
└── apps/
    └── web/             # cliente React + Vite + pdf.js
```

- **packages/shared** — sin E/S, solo zod. Es el contrato que consumirán el CRM
  de DEPARTIFY, una herramienta MCP o cualquier otro cliente.
- **packages/server** — `node:http` + `node:sqlite` (biblioteca estándar, sin
  compilación nativa) y `pdf-lib` para el sellado del PDF.
- **apps/web** — React con pdf.js para el renderizado. Todo el cliente se
  sirve desde el propio servidor: un único puerto, sin CDN.

### Por qué `node:sqlite`

Permite que `pnpm install` funcione en cualquier máquina sin compilador y que
la base de datos sea un único fichero. La configuración incluye
`busy_timeout`, transacciones `BEGIN IMMEDIATE` y reintentos ante
`SQLITE_BUSY`, de modo que varias instancias pueden compartir el mismo
fichero sin corromper datos.

---

## API

Todas las rutas cuelgan de `/api`. El contrato completo (con esquemas zod) está
en `packages/shared/src/index.ts`.

### Emisor

| Método | Ruta                              | Descripción                        |
| ------ | --------------------------------- | ---------------------------------- |
| `GET`  | `/api/health`                     | Estado del servicio                 |
| `GET`  | `/api/envelopes`                  | Listado de solicitudes              |
| `POST` | `/api/envelopes`                  | Crear solicitud (PDF en base64)    |
| `GET`  | `/api/envelopes/:id`              | Detalle con firmantes y auditoría  |
| `POST` | `/api/envelopes/:id/send`         | Enviar a los firmantes             |
| `POST` | `/api/envelopes/:id/remind`       | Registrar recordatorio             |
| `POST` | `/api/envelopes/:id/cancel`       | Cancelar la solicitud              |
| `GET`  | `/api/envelopes/:id/audit`        | Registro de auditoría              |
| `GET`  | `/api/envelopes/:id/audit/verify` | Verificar la cadena                |
| `GET`  | `/api/envelopes/:id/document`     | Documento original (PDF)           |
| `GET`  | `/api/envelopes/:id/signed`       | Documento firmado (PDF)            |

### Firmante

| Método | Ruta                                | Descripción                       |
| ------ | ----------------------------------- | --------------------------------- |
| `GET`  | `/api/signing/:token`                | Sala de firma (solo sus campos)   |
| `GET`  | `/api/signing/:token/document`       | Documento a firmar                |
| `POST` | `/api/signing/:token/otp`            | Solicitar código de verificación  |
| `POST` | `/api/signing/:token/otp/verify`     | Validar el código                 |
| `POST` | `/api/signing/:token/sign`           | Firmar                            |
| `POST` | `/api/signing/:token/decline`        | Rechazar                          |

### Ejemplo

```bash
# Crear y enviar
curl -X POST http://127.0.0.1:4310/api/envelopes \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Acuerdo de servicios",
    "documentBase64": "'"$(base64 -i contrato.pdf | tr -d '\n')"'",
    "fileName": "contrato.pdf",
    "signatureLevel": "simple",
    "signingOrder": "sequential",
    "recipients": [
      { "name": "Ana Ruiz", "email": "ana@empresa.com", "role": "signer", "order": 1, "ref": "r1" }
    ],
    "fields": [
      { "id": "firma", "type": "signature", "required": true, "recipientRef": "r1",
        "placement": { "page": 1, "x": 60, "y": 700, "width": 180, "height": 60 } }
    ]
  }'
```

El campo `metadata` acepta cualquier objeto JSON: ahí encaja el `contactId` del
CRM para que la firma quede asociada a un contacto de DEPARTIFY.

---

## Pruebas

```bash
pnpm test     # 10 pruebas unitarias del dominio
pnpm e2e      # 20 comprobaciones end-to-end contra un servidor real
pnpm typecheck
```

La prueba end-to-end arranca el servidor en un puerto efímero y recorre el
flujo completo: crear, enviar, comprobar el orden secuencial, firmar, descargar
el PDF firmado y verificar la cadena de auditoría.

---

## Integración con DEPARTIFY

El repositorio está aislado del CRM a propósito: la capa de datos, el motor de
PDF y la API son independientes.

Puntos de enganche previstos:

1. **CRM → Signature.** El CRM llama a `POST /api/envelopes` con el `contactId`
   en `metadata` y guarda el `envelopeId` en el contacto.
2. **Signature → CRM.** `packages/shared` es el contrato; las automatizaciones
   pueden consumir `GET /api/envelopes/:id/audit` para saber qué ha pasado sin
   acoplarse al almacenamiento.
3. **Migración a Postgres.** La lógica de negocio vive en
   `packages/server/src/service.ts` y no toca SQL; solo hay que sustituir la
   capa `Store`.

---

## Licencia

MIT.
