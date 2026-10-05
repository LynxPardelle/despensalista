# Stack tecnico

## Resumen

Despensa Lista es una aplicacion Angular con API NestJS. La ruta alojada es
serverless en AWS; Docker y MongoDB existen para desarrollo y compatibilidad
local. Este documento enumera capacidad versionada, no certifica por si solo el
estado desplegado de un stage.

## Frontend

- Angular `21.2.x`, TypeScript `5.9.x`, RxJS `7.8` y NgRx `21.x`.
- Bootstrap y estilos SCSS propios; no depende de un design system externo.
- Compilacion con Angular application builder, prerender y entrada SSR Express.
- En serverless se publica `frontend/dist/frontend/browser` en S3/CloudFront;
  SSR se conserva para Docker/local, no para la topologia AWS.
- Karma/Jasmine cubre unitarias y Playwright los recorridos de navegador.
- Un service worker propio (`frontend/public/despensalista-sw.js`) aporta una
  capa offline basica, no sincronizacion transaccional.

## Backend

- Node.js 22, NestJS 11, adaptador Fastify 5 y TypeScript 5.7.
- Cognito gestiona identidad; el backend usa cookies HttpOnly/Secure y verifica
  JWT, state, nonce y PKCE.
- Persistencia seleccionable por `PERSISTENCE_PROVIDER`:
  - DynamoDB en AWS.
  - MongoDB/Mongoose 8 en desarrollo local y Docker.
- Las mutaciones criticas comparten el puerto `PantryMutationPort`: transacciones
  DynamoDB o MongoDB, recibos idempotentes de siete dias, cuotas atomicas y
  fences de borrado.
- MongoDB debe ejecutarse como replica set; el compose local inicializa un nodo
  `rs0` para poder ofrecer transacciones.
- La ejecucion AWS es una Lambda ARM64 Node.js 22 detras de API Gateway HTTP
  API.

## Infraestructura y entrega

- AWS CDK 2 (`infra/cognito`) administra Cognito, Lambda, API Gateway,
  DynamoDB, S3, CloudFront, ACM, Route53, SES/DKIM, logs y alarmas.
- DynamoDB usa capacidad on-demand, cifrado administrado, TTL, PITR y
  protecciones productivas de borrado.
- S3 es privado, versionado para recuperacion de releases y CloudFront usa
  Origin Access Control.
- Los pools locales requieren TOTP y usan `COGNITO_DEFAULT` (50 mensajes/dia)
  sin remitente custom. La identidad SES/DKIM verificada queda preparada para
  habilitarse solo cuando la cuenta salga del sandbox.
- GitHub Actions ejecuta CI, validacion CDK y promociones inmutables
  `dev -> tst -> prod` por OIDC. Cada stage tiene rol de deploy, rol
  CloudFormation, permissions boundary y bucket de assets aislados.
- El rollback usa un recibo de despliegue exacto y restaura juntos alias Lambda
  y frontend. Coincidir solo por hash de ZIP no es suficiente.
- El plan CloudFront `FREE`/WAF incluido se intenta solo cuando AWS declara la
  distribucion elegible. Ante el rechazo observado, el fallback versionado es
  CloudFront PAYG de bajo trafico sin WAF; no se crea WAF PAYG porque excede el
  limite de costo.

## Entornos versionados

| Entorno | Runtime | Persistencia | Contrato de entrega |
| --- | --- | --- | --- |
| Local | Angular/SSR + Nest/Fastify | MongoDB `rs0` o DynamoDB | `npm` o Docker Compose |
| `dev` | CloudFront/S3 + API Gateway/Lambda | DynamoDB | Construye, despliega y publica el artefacto inmutable |
| `tst` | CloudFront/S3 + API Gateway/Lambda | DynamoDB | Promueve el artefacto de `dev` tras merge verificado |
| `prod` | CloudFront/S3 + API Gateway/Lambda | DynamoDB | Promueve el artefacto de `tst` con gate de environment |

El informe final de 2026-09-26 es la fuente para saber que stages terminaron
desplegados y verificados; la tabla anterior solo describe el contrato.

## Operacion de bajo costo

- Logs API/Lambda con retencion acotada, cuatro alarmas operativas y una alarma
  sin acciones para el guard de correo en produccion.
- Smoke publico horario en GitHub Actions; sin CloudWatch Synthetics.
- Un secreto de verificacion de origen independiente para cada stage: `dev`,
  `tst` y `prod`.
- Ensayo PITR de las cuatro tablas completado el 2026-09-25; no sustituye un
  failover completo cronometrado.

## Restricciones de version

- Los lockfiles son parte del contrato reproducible y CI usa `npm ci`.
- Las imagenes Docker fijan digest y el workflow de cadencia detecta rezago.
- Las dependencias de runtime deben mantener `npm audit --omit=dev` en cero.
- Los advisories transitivos de herramientas de desarrollo no se corrigen con
  upgrades mayores automaticos; se actualizan cuando exista una ruta compatible
  y las pruebas completas permanezcan verdes.
