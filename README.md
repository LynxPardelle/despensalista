# Despensa Lista

Despensa Lista es una aplicacion para registrar inventario del hogar por tipo
base y por lote, con foco en caducidades, durabilidad, compras y consumo. La
produccion vigente es serverless en AWS; Docker/MongoDB se conserva para
desarrollo local y la documentacion de Dokploy es historica.

## Estado actual

- Autenticacion reemplazada por Amazon Cognito Hosted UI: Despensa Lista ya no
  registra ni valida passwords locales en el flujo activo
- Perfil local `users` conservado para propiedad de despensa, con
  `User.id = Cognito sub`
- Modelo nuevo `ProductType` + `InventoryLot`
- Registro de compras como lotes con `expiresAt` y `purchaseDate`
- Vista agrupada por tipo base
- Panel visible de productos proximos a caducar
- Panel visible de productos que se agotan pronto por durabilidad estimada
- Plan de compras deterministico basado en agotamiento estimado
- Durabilidad calculada desde la fecha de compra del lote cuando existe
- Plan de compras que conserva tipos con durabilidad aunque el stock activo
  llegue a cero
- Overrides por tipo base para caducidad, agotamiento y dias de compra
- Archivado/restauracion de tipos y lotes, con borrado permanente guardado
  detras de confirmacion
- Consumo explicito por lote, sin seleccion automatica
- Backend NestJS 11 + Fastify + DynamoDB en produccion
- MongoDB/Mongoose como adaptador de desarrollo local
- Frontend Angular 21 + NgRx + SSR
- Flujo de migracion desde la coleccion legacy `products`

## Stack

La topologia productiva actual es Route53/ACM -> CloudFront -> S3 privado para
el frontend y CloudFront `/api` -> API Gateway HTTP API -> Lambda Node.js 22 ->
DynamoDB para la API. Cognito Managed Login gestiona identidad local y Google.
El codigo versionado vive en `infra/cognito`.

### Frontend

- Angular 21
- NgRx
- Bootstrap 5
- SSR con Express

### Backend

- NestJS 11
- Fastify
- Mongoose
- Arquitectura por dominio / casos de uso / infraestructura

## Modelo actual

- `ProductType`
  - representa el tipo base que importa para planear el hogar
  - ejemplos: `Atun`, `Jamon de pierna de pavo`, `Shampoo anticaspa`
  - puede incluir una regla opcional `defaultDepletionRule` para estimar
    durabilidad por tipo base
- `InventoryLot`
  - representa una compra o bloque homogeneo con cantidad, variante y
    caducidad propia
  - no guarda reglas de durabilidad; las cantidades manuales del lote siguen
    siendo la fuente persistida para ajustes reales
- `PantryOverview`
  - agrega lotes por tipo base y entrega al frontend el resumen listo para
    renderizar
  - calcula `estimatedCurrentQuantity`, `estimatedConsumedQuantity`,
    `estimatedDepletionAt` y `depletingItems` en lectura, sin mutar inventario
  - expone `shoppingPlanItems` como cronograma simple de reposicion: comprar
    antes del agotamiento estimado segun el default del perfil o el override
    del tipo base
  - se construye desde tipos activos, no solo lotes activos, para que un tipo
    durable con cero stock siga apareciendo como compra sugerida
- El flujo legacy `/api/products` sigue presente solo como compatibilidad de
  transicion; la ruta principal nueva vive en `/api/product-types`,
  `/api/inventory-lots` y `/api/pantry/overview`

## Desarrollo local

### 1. Arranca todo con Docker Compose

La ruta mas simple en esta maquina ahora es levantar `frontend`, `backend` y
`mongodb` juntos con Docker Compose:

```bash
cp .env.docker.example .env.docker.local
docker compose --env-file .env.docker.local --profile app up -d --build
```

Esto levanta:

- MongoDB en `127.0.0.1:37917`
- backend en `http://localhost:39173/api`
- frontend en `http://localhost:48673`
- volumen persistente nombrado
- replica set MongoDB `rs0` de un nodo y `healthcheck` que espera al primario
- usuario root separado del usuario de aplicacion
- usuario de aplicacion con permisos `readWrite` solo sobre `despensalista`
- `restart: unless-stopped` para los tres servicios

En desarrollo, el navegador debe seguir viendo las llamadas API sobre
`http://localhost:48673/api/...`. Eso es intencional: el frontend Angular usa
`/api` como base relativa y el dev server reenvia esas solicitudes al backend
real dentro de Docker en `http://backend:3000`.

Los puertos publicados del host son intencionalmente altos y poco comunes para
que este stack pueda quedarse arriba sin chocar con otros proyectos. Puedes
cambiarlos en `.env.docker.local` con `DESPENSALISTA_MONGO_HOST_PORT`,
`DESPENSALISTA_BACKEND_HOST_PORT` y `DESPENSALISTA_FRONTEND_HOST_PORT`.

El `backend` ya no depende de un `DATABASE_URL` duplicado en el archivo Docker.
Ahora construye su conexion desde `MONGO_HOST`, `MONGO_PORT`,
`MONGO_APP_DATABASE`, `MONGO_APP_USERNAME` y `MONGO_APP_PASSWORD`, lo que evita
que se quede usando el password por defecto cuando ya existe un `.env.docker.local`.

La autenticacion Cognito queda desactivada por defecto en
`.env.docker.example` para que el stack local pueda arrancar sin un User Pool
real. Al habilitarla, registra en Cognito el callback local:

```text
http://localhost:48673/api/auth/cognito/callback
```

Con `COGNITO_ENABLED=true`, configura tambien `COGNITO_ISSUER`,
`COGNITO_DOMAIN`, `COGNITO_CLIENT_ID`, `COGNITO_REDIRECT_URI` y
`COGNITO_LOGOUT_REDIRECT_URI`. Si esas variables no existen, los endpoints de
auth fallan cerrados en vez de volver al login local con password.

Si prefieres seguir con `mongodb` en Docker y `frontend` / `backend` fuera de
contenedor, tambien sigue siendo valido:

```bash
docker compose --env-file .env.docker.local up -d mongodb
```

El replica set se inicializa automáticamente y conserva los datos existentes.
El keyfile interno se genera en el volumen, con permisos `400`; no se guarda en
Git. Las compras y consumos usan transacciones, por eso una instancia MongoDB
standalone ya no es compatible. Dentro de Docker se descubre `mongodb:27017`;
fuera de Docker usa el `DATABASE_URL` de abajo con `directConnection=true` y
deja `MONGO_HOST` sin definir. Este nodo único es para desarrollo, no alta
disponibilidad. Los compose de producción usan DynamoDB y no agregan MongoDB.
Al desplegar una nueva versión del esquema de cuotas MongoDB, detén primero
todos los escritores y deja que la primera mutación complete el backfill antes
de reanudarlos; no se admite un rolling deploy entre binarios con contratos de
cuota distintos.

Comprueba la inicialización con `docker compose --env-file .env.docker.local ps`
y el contrato de healthcheck con `node --test docker/mongodb/replica-health.test.mjs`.

### Solucion de problemas del stack Docker local

- Si el navegador muestra errores contra `http://localhost:48673/api/...`, no
  cambies el frontend a `http://localhost:39173`. Primero valida el backend, ya
  que `localhost:48673/api` es el contrato correcto en desarrollo.
- Si `despensalista-backend` queda en bucle con errores de TypeScript por modulos
  faltantes de Node/Nest, el contenedor tenia
  un `node_modules` de Docker desincronizado. El `docker-compose.yml` de
  desarrollo ahora ejecuta `npm ci --include=dev` al arrancar para reparar ese
  volumen antes de levantar NestJS y Angular.
- Si el backend sigue ejecutando logica vieja despues de un cambio de codigo,
  el compose de desarrollo ahora limpia `dist` y `tsconfig.tsbuildinfo` antes
  de entrar en `nest start --watch`, evitando que el contenedor arranque con
  artefactos compilados stale.
- Si `despensalista-mongodb` queda `unhealthy` y los logs muestran
  `SCRAM authentication failed` o `storedKey mismatch`, tu volumen persistente
  fue inicializado con credenciales de una version anterior del stack. Primero
  intenta la reparacion no destructiva; el script no imprime secretos y actualiza
  solo usuarios de MongoDB para que coincidan con `.env.docker.local`:

```powershell
.\docker\mongodb\Repair-DockerMongoCredentials.ps1 -EnvFile .env.docker.local
```

- Si conoces las credenciales historicas exactas con las que se creo el volumen,
  tambien puedes restaurarlas en `.env.docker.local` y reiniciar el stack.
- Reiniciar solo el entorno Docker local es la opcion destructiva: si puedes
  perder esos datos de desarrollo, baja el stack y elimina el volumen antes de
  volver a levantarlo.

```bash
docker compose --profile app down
docker volume rm despensalista_mongodb_data
docker compose --env-file .env.docker.local --profile app up -d --build
```

Ese reset es destructivo solo para la base local montada en Docker.

Ejemplo de `backend/.env`:

```env
NODE_ENV=development
PORT=3000
DATABASE_URL=mongodb://despensalista_app:change-this-app-password@127.0.0.1:37917/despensalista?authSource=despensalista&replicaSet=rs0&directConnection=true
DATABASE_NAME=despensalista
API_PREFIX=api
CORS_ORIGIN=http://localhost:48673
HELMET_ENABLED=true
RATE_LIMIT_ENABLED=true
RATE_LIMIT_MAX=120
RATE_LIMIT_TIME_WINDOW=1 minute
RATE_LIMIT_TRUST_PROXY=false
SWAGGER_ENABLED=true
SWAGGER_TITLE=Despensa Lista API
SWAGGER_DESCRIPTION=Despensa Lista API
SWAGGER_VERSION=1.0.0
COGNITO_ENABLED=false
AUTH_ACCESS_COOKIE_TTL_SECONDS=900
AUTH_REFRESH_COOKIE_TTL_SECONDS=2592000
```

### 2. Arranca el backend fuera de Docker

```bash
cd backend
npm install
npm start
```

La API queda en `http://localhost:3000/api`.
Swagger queda en `http://localhost:3000/api/docs` si `SWAGGER_ENABLED=true`.

### 3. Arranca el frontend fuera de Docker

```bash
cd frontend
npm install
npm start
```

La app queda en `http://localhost:4200`.
Usa `http://localhost:4200`, no `http://127.0.0.1:4200`, porque en esta
maquina el smoke test local respondio bien sobre `localhost` y rechazo
`127.0.0.1`.

## Scripts utiles

### Frontend

```bash
npm start
npm run build
npm test
npm run test:ci
```

### Backend

```bash
npm start
npm run start:dev
npm run lint
npm test
npm run test:e2e
npm run build
npm run migrate:product-types
```

### Cognito AWS/CDK

```bash
cd infra/cognito
npm ci
npm run build
npm run synth
```

La configuracion repetible de Cognito vive en `infra/cognito`; la guia de
despliegue esta en `docs/deployment/cognito.md`.

## API nueva

- `GET /api/auth/cognito/login`
- `GET /api/auth/cognito/callback`
- `GET /api/auth/me`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `POST /api/product-types`
- `GET /api/product-types?search=...`
- `GET /api/product-types/:id`
- `PATCH /api/product-types/:id/depletion-rule`
- `PATCH /api/product-types/:id/planning-settings`
- `POST /api/product-types/:id/archive`
- `POST /api/product-types/:id/restore`
- `DELETE /api/product-types/:id`
- `POST /api/inventory-lots`
- `GET /api/inventory-lots`
- `GET /api/inventory-lots/expiring?days=7`
- `POST /api/inventory-lots/:id/consume`
- `POST /api/inventory-lots/:id/archive`
- `POST /api/inventory-lots/:id/restore`
- `DELETE /api/inventory-lots/:id`
- `GET /api/pantry/overview`
- `GET /api/pantry/archived`

## Migracion

La migracion conserva los registros legacy de forma conservadora:

- crea un `ProductType` por producto legacy
- crea un `InventoryLot` inicial por producto legacy
- no inventa caducidades historicas
- usa `legacyProductId` para evitar duplicados al reejecutarse
- puede sembrar `legacy_account_claims` sin resetear reclamos ya existentes

Ejecucion:

```bash
cd backend
npm run migrate:product-types
```

Para poblar reclamos de cuentas legacy a partir de `products`,
`product_types` e `inventory_lots` sin sobreescribir registros ya
`claimed`/`claiming`, usa:

```bash
cd backend
npx ts-node ./scripts/seed-legacy-account-claims.ts
```

Ese comando corre en modo seguro (`dryRun`) por defecto y devuelve el listado
exacto de `legacyOwners` detectados. Para aplicar los upserts idempotentes en
`legacy_account_claims`, agrega `--apply`:

```bash
cd backend
npx ts-node ./scripts/seed-legacy-account-claims.ts --apply
```

Salida validada en esta maquina:

```json
{
  "status": "ok",
  "legacyProductCount": 2,
  "createdProductTypes": 2,
  "createdInventoryLots": 2,
  "skippedInventoryLots": 0
}
```

## Verificacion 2026-04-22

Verificacion de codigo:

- Frontend: `npm run build`
- Frontend: `npm run test:ci`
- Backend: `npm run lint`
- Backend: `npm test`
- Backend: `npm run test:e2e`
- Backend: `npm run build`

Verificacion de runtime:

- `npm audit --omit=dev --json` devolvio `0` vulnerabilidades de runtime en
  `frontend`
- `npm audit --omit=dev --json` devolvio `0` vulnerabilidades de runtime en
  `backend`
- `Invoke-WebRequest http://localhost:48673/login` devolvio `StatusCode = 200`
- `docker compose --env-file .env.docker.local --profile app ps` mostro
  `despensalista-backend`, `despensalista-frontend` y `despensalista-mongodb` en estado
  `Up`, con MongoDB marcado como `healthy`
- `GET /api/inventory-lots/expiring?userId=lot-api-user&days=7` devolvio `2`
  lotes para el grupo de prueba
- `GET /api/inventory-lots/expiring?userId=lot-api-user&days=30` devolvio `3`
  lotes para el mismo grupo despues de registrar un lote estable adicional
- Las verificaciones antiguas con `userId` por query quedaron superadas por
  la autenticacion actual con cookies y `AccessTokenGuard`.
- `npm run build` de `frontend` ya no emitio warning de presupuesto para
  `pantry-page.component.scss` despues de mover primitivas visuales al
  stylesheet global
- `GET /api/pantry/overview` ahora incluye `shoppingPlanItems` para tipos con
  durabilidad activa; el plan sugiere una compra de una ventana de consumo y
  ordena por `recommendedPurchaseAt`
- Smoke de durabilidad en navegador sobre Docker registro
  `Detergente smoke 411900`; despues de crear el lote devolvio
  `totalQuantity = 4`, `estimatedCurrentQuantity = 1`,
  `estimatedConsumedQuantity = 3` y `depletingCount = 1`
- El mismo smoke consumio manualmente `1 lt` desde el lote y el overview quedo
  en `totalQuantity = 3`, `estimatedCurrentQuantity = 0`,
  `estimatedConsumedQuantity = 3`, `hasDepletionRule = true`

Evidencia visual existente:

- `C:\Users\lince\Documents\GitHub\Codex\Output\despensalista-expiration-smoke.png`
- `C:\Users\lince\Documents\GitHub\Codex\Output\despensalista-smoke.png`
- `C:\Users\lince\Documents\GitHub\Codex\Output\despensalista-durability-smoke.png`

## Verificacion 2026-04-29

Verificacion de replenishment, reglas por tipo y archivado:

- Backend: `npm test -- --runInBand` paso `30` suites y `95` tests
- Backend: `npm run test:e2e` paso `2` tests
- Backend: `npm run build` paso
- Frontend: `npm run test:ci` paso `31` specs
- Frontend: `npm run build` paso con bundle inicial `457.00 kB` y
  `pantry-module` lazy de `56.93 kB`
- Frontend: `$env:E2E_BASE_URL='http://localhost:48673'; npm run test:e2e`
  paso `5` tests
- Docker: `docker compose --env-file .env.docker.local --profile app up -d --build`
  reconstruyo backend/frontend y dejo MongoDB, backend y frontend arriba
- HTTP smoke: backend `http://localhost:39173/api/healthz` devolvio `200`;
  frontend `http://localhost:48673/login` devolvio `200`
- Seguridad: `npm audit --omit=dev --json` devolvio `total = 0` en backend
  y frontend; `security-compliance` secret scan devolvio `count = 0`

## Seguridad

- El backend usa Fastify 5 a traves de NestJS y mantiene el lockfile auditado;
  no fija una version vulnerable mediante `overrides`.
- MongoDB en Docker queda expuesto solo en `127.0.0.1:37917`.
- Las rutas principales de pantry, lotes, tipos base y productos legacy usan
  `AccessTokenGuard` y derivan el usuario desde `@CurrentUser()`, no desde
  `userId` enviado por el cliente.
- El guardado de `ProductType` ahora usa un upsert por
  `(userId, normalizedBaseName)` para reducir la ventana de duplicados por
  carreras en la ruta normal de la aplicacion.
- Las estimaciones de durabilidad se calculan dinamicamente al leer el overview
  y no mutan cantidades ni borran lotes de forma automatica.
- En AWS, Cognito entrega registro y recuperacion con su remitente administrado
  y la cuota compartida de 50 mensajes diarios. La identidad
  `despensalista.lynxpardelle.com` y DKIM estan verificados, pero el remitente
  propio no se habilita mientras SES siga sin acceso de produccion.

## Skills evaluadas en esta pasada

- `create-implementation-plan`
  - util para convertir la especificacion aprobada en
    `plan/feature-expiration-lots-1.md`
- `frontend-skill`
  - aporto una direccion visual util para evitar que la UI quedara como un CRUD
    plano y sin jerarquia
- `agent-browser`
  - no fue confiable para esta app local en esta maquina
  - evidencia exacta observada antes del fallback: `chrome-error://chromewebdata/`
    y `agent-browser doctor --offline --quick --json` expiro por timeout
- `code-reviewer`
  - no se pudo usar porque el wrapper local devolvio el error exacto
    `config profile 'code-reviewer' not found`

## Dokploy (legado)

**No ejecutes esta ruta contra AWS.** La produccion actual ya no usa Dokploy, la
instancia EC2 fue retirada y estos archivos no son un mecanismo de rollback. Se
conservan como evidencia y para una prueba Compose local aislada. Historicamente,
`docker-compose.prod.yml` construia imagenes de runtime, servia el frontend SSR
en un proceso Node estable y mantenia el backend solo en la red interna.

- Backend: configura `PERSISTENCE_PROVIDER=dynamodb`, `AWS_REGION`,
  `DYNAMODB_*_TABLE`, `API_PREFIX`, `CORS_ORIGIN`, `HELMET_ENABLED` y
  `SWAGGER_ENABLED`.
- Frontend SSR: si se despliega el servidor SSR, puedes definir `BACKEND_URL`
  para que el proxy del servidor apunte al backend correcto.
- Frontend SSR/proxy: el navegador llama `/api` en el mismo dominio del
  frontend; el servidor SSR reenvia esas llamadas a `BACKEND_URL`.
- Para una topologia de produccion **solo local** segun el spec del
  `2026-04-23`, usa `docker-compose.prod.yml`.
- Ese compose mantiene `frontend` SSR publico, `backend` solo por red interna y
  DynamoDB como persistencia externa.
- Variables obligatorias para ese flujo: `PERSISTENCE_PROVIDER=dynamodb`,
  `AWS_REGION`, `DYNAMODB_USERS_TABLE`, `DYNAMODB_PRODUCTS_TABLE`,
  `DYNAMODB_PRODUCT_TYPES_TABLE`, `DYNAMODB_INVENTORY_LOTS_TABLE`,
  `COGNITO_ENABLED=true`, `COGNITO_ISSUER`, `COGNITO_DOMAIN`,
  `COGNITO_CLIENT_ID`, `COGNITO_REDIRECT_URI` y
  `COGNITO_LOGOUT_REDIRECT_URI`.
- Para crear esos valores con infraestructura versionada, usa el CDK app en
  `infra/cognito`; ahora tambien crea DynamoDB, CloudFront, ACM, Route53 e IAM
  para produccion.
- Variables utiles para override: `DATABASE_NAME`, `FRONTEND_PORT`,
  `CORS_ORIGIN`, `API_PREFIX`, `BACKEND_URL`, `AUTH_COOKIE_SECURE`,
  `AUTH_COOKIE_SAME_SITE` y `AUTH_COOKIE_DOMAIN`.
- `docs/deployment/dokploy.md` es un archivo historico, no una guia operativa.
- La referencia a `docker-compose.dokploy.yml` y `dokploy-network` solo explica
  el host retirado; no recrees una EC2 ni esa red para Despensa Lista.
- Smoke local de produccion:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production.local up -d --build
```
