# Backend definitivo · Comunicación Interna SSM

Este backend reemplaza Basin cuando esté desplegado y probado.

## Arquitectura

- GitHub Pages: formulario público.
- Cloudflare Worker: recibe y valida solicitudes.
- Cloudflare D1: guarda los datos editoriales.
- Cloudflare R2: guarda adjuntos.
- Brevo (opcional): envía la notificación HTML por correo.

## Recursos Cloudflare a crear

1. Worker: `ssm-comunicacion-interna`
2. D1: `comunicacion-interna`
3. R2: `solicitudes-comunicacion`

## Configuración inicial

### 1. Instalar dependencias

```bash
npm install
```

### 2. Iniciar sesión en Cloudflare

```bash
npx wrangler login
```

### 3. Crear D1

```bash
npx wrangler d1 create comunicacion-interna
```

Copiar el `database_id` entregado por Cloudflare y reemplazar `REEMPLAZAR_DATABASE_ID` en `wrangler.jsonc`.

### 4. Crear R2

```bash
npx wrangler r2 bucket create solicitudes-comunicacion
```

### 5. Crear tablas

```bash
npx wrangler d1 execute comunicacion-interna --remote --file=./schema.sql
```

### 6. Crear token administrativo

```bash
npx wrangler secret put ADMIN_TOKEN
```

Usar un valor largo y aleatorio. No guardarlo en GitHub.

### 7. Correo opcional mediante Brevo

En `wrangler.jsonc`, cambiar:

```json
"MAIL_PROVIDER": "none"
```

a:

```json
"MAIL_PROVIDER": "brevo"
```

Luego configurar:

```bash
npx wrangler secret put BREVO_API_KEY
```

Agregar a `vars` un remitente previamente validado por el proveedor:

```json
"SENDER_EMAIL": "direccion-validada@dominio.cl"
```

La notificación ya incluye un diseño HTML institucional, prioridad, tema, solicitante, público, fechas, antecedentes y listado de archivos.

> Importante: el correo es una notificación. La fuente oficial de la solicitud es D1 y los archivos se conservan en R2.

### 8. Desplegar

```bash
npm run deploy
```

Cloudflare entregará una URL similar a:

`https://ssm-comunicacion-interna.<cuenta>.workers.dev`

## Endpoint público

`POST /api/solicitudes`

Acepta `multipart/form-data` con los mismos nombres de campos que utiliza el formulario actual.

Límite propio del sistema: **10 MB totales de adjuntos por solicitud**.

## Endpoints administrativos

Requieren:

`Authorization: Bearer <ADMIN_TOKEN>`

- `GET /api/solicitudes`
- `GET /api/solicitudes/:id`
- `GET /api/archivo?key=<r2_key>`

Estos endpoints servirán más adelante para alimentar la Bandeja Editorial de la aplicación de mailing.

## Paso de Basin a Cloudflare

No cambiar el formulario productivo hasta verificar que el Worker registra correctamente una solicitud y sus archivos.

Una vez validado, cambiar el `action` del formulario desde Basin a:

`https://<worker>.workers.dev/api/solicitudes`

Luego se puede retirar Basin sin perder el formulario.
