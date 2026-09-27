# Integraciones

## Amazon Cognito

- Managed Login v2 con flujo Authorization Code + PKCE.
- Email/password local de Cognito y proveedor Google configurado externamente.
- El backend usa issuer, client id, dominio y user pool para verificar tokens,
  cerrar sesiones y eliminar identidades.
- El cliente es publico (`generateSecret: false`) y evita revelar existencia
  de usuarios.
- Los tres pools requieren TOTP (`MfaConfiguration=ON`) para usuarios locales;
  Google conserva la politica MFA de su propio proveedor.
- Produccion usa el remitente verificado
  `no-reply@despensalista.lynxpardelle.com` con entrega administrada por
  Cognito. SES/DKIM esta verificado, pero el acceso de produccion SES sigue
  denegado y el limite administrado es 50 mensajes diarios por cuenta.

## DynamoDB

- Cuatro tablas on-demand con cifrado AWS, TTL y Point-in-Time Recovery.
- `users` usa `pk` y los indices `gsi1`/`gsi2` para perfiles, hogares, listas y
  enlaces.
- `products`, `product-types` e `inventory-lots` usan ids y GSIs por usuario.
- La Lambda tiene permisos por stage, dentro de una permissions boundary. Las
  mutaciones de consumo, merma, checkout, cuotas y fences de borrado usan
  transacciones sobre las tablas implicadas.

## CloudFront, S3, Route53 y ACM

- CloudFront sirve un bucket privado y reenvia `api/*` a API Gateway.
- Una CloudFront Function resuelve rutas SPA y `/healthz` del frontend.
- Headers de seguridad se agregan en CloudFront.
- CloudFront inyecta un secreto de origen que la API exige; invocar directamente
  el endpoint de API Gateway no da acceso a la aplicacion.
- El plan CloudFront `FREE` rechazo las distribuciones como no elegibles. No se
  creo un WAF de pago porque su costo fijo excede el limite aprobado.

## API Gateway y Lambda

- HTTP API con CORS restringido al frontend y Lambda Node.js 22 ARM64.
- Memoria por defecto: 512 MiB; timeout: 15 s.
- Cada release publica una version Lambda y sirve mediante el alias `live`;
  produccion usa CodeDeploy `ALL_AT_ONCE` con alarmas de rollback. Antes del
  cambio de alias, el workflow fija temporalmente reserved concurrency en cero,
  espera el timeout mas cinco segundos, elimina de forma condicionada solamente
  cuotas `PANTRY_QUOTA` sin fence activo y restaura la concurrencia previa. Este
  drenaje corre solo cuando cambia `PantryQuotaSchemaVersion` o el alias vivo fue
  revertido; la version actual del contrato es `2`.
- API/Lambda tienen logs con retencion acotada. Cuatro alarmas productivas
  cubren errores/throttling Lambda, API 5xx y CloudFront 5xx.
- La API aplica throttling. No hay reserved concurrency permanente ni DLQ porque
  el flujo HTTP es sincrono; reserved concurrency cero se usa solamente durante
  el drenaje controlado de una release productiva.

## GitHub Actions y AWS OIDC

- CI ejecuta pruebas, audits, CodeQL, gitleaks, Trivy y smoke de produccion.
- Los environments `dev`, `tst` y `prod` aceptan exclusivamente su rama y usan
  un rol OIDC y un rol CloudFormation aislados por stage, sin llaves AWS
  duraderas. `prod` exige aprobacion del environment configurado.
- La release se construye una sola vez en `dev`; `tst` y `prod` verifican y
  promueven exactamente el mismo manifest/artifacto. El rollback usa el recibo
  de despliegue y la version Lambda exacta, no una coincidencia ambigua de ZIP.

## Google

- Cognito delega el login social a Google. El secreto/configuracion del
  proveedor es externo al stack y no debe guardarse en Git.
- El callback del proveedor es el endpoint `/oauth2/idpresponse` de Cognito.

## MongoDB y Docker

- Integracion local opcional para desarrollo; no forma parte de la topologia
  productiva observada.
- Las credenciales locales se toman de un archivo no versionado basado en
  `.env.docker.example`.
- Los scripts de reparacion de credenciales solo deben ejecutarse contra el
  volumen local exacto.

## APIs del navegador

- `localStorage` para presupuesto, borradores, modo compra y cola offline;
  desde esta auditoria todo esta aislado y versionado por usuario.
- Wake Lock, voz y camara/codigo de barras se usan con degradacion progresiva.
- Service Worker/cache aporta soporte offline parcial, no una garantia de
  sincronizacion transaccional.
