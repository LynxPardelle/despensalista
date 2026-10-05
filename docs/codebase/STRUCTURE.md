# Estructura del repositorio

```text
despensalista/
|-- backend/                 API NestJS y adaptadores de persistencia
|   |-- src/application/     casos de uso, puertos, servicios y read models
|   |-- src/domain/          entidades, value objects, enums y repositorios
|   |-- src/infrastructure/  Cognito, DynamoDB, MongoDB y HTTP
|   |-- scripts/             migraciones y utilidades operativas
|   `-- test/                pruebas e2e de API
|-- frontend/                aplicacion Angular
|   |-- src/app/core/        guards y clientes HTTP
|   |-- src/app/features/    login, despensa, perfil, legal y listas compartidas
|   |-- src/app/store/       slices NgRx
|   |-- e2e/                 recorridos Playwright
|   `-- public/              manifest, icono y service worker
|-- infra/cognito/           aplicacion CDK para toda la ruta AWS
|   |-- bin/                 composicion de stacks
|   |-- lib/                 Cognito, backend serverless y controles de entrega por stage
|   `-- test/                regresiones de sintesis CDK
|-- .github/workflows/       CI, seguridad, promociones y deploy
|-- docs/                    decisiones, despliegues, privacidad e investigacion
|-- docker/                  soporte de MongoDB local
`-- tools/                   validaciones de privacidad y utilidades de repo
```

## Puntos de entrada

- Navegador: `frontend/src/main.ts`.
- SSR/proxy Docker: `frontend/src/server.ts`.
- API de proceso: `backend/src/main.ts`.
- API Lambda: `backend/src/lambda.ts`.
- Composicion Nest: `backend/src/app.module.ts`.
- Composicion CDK: `infra/cognito/bin/despensalista-cognito.ts`.

## Donde hacer cada cambio

| Necesidad | Ubicacion principal |
| --- | --- |
| Regla de negocio | `backend/src/domain/` o `backend/src/application/use-cases/` |
| Contrato HTTP | `backend/src/infrastructure/http/` |
| Consulta/escritura DynamoDB | `backend/src/infrastructure/database/dynamodb/` |
| Persistencia local MongoDB | `backend/src/infrastructure/database/mongodb/` |
| Flujo de pantalla | `frontend/src/app/features/` |
| Cliente API/modelo compartido | `frontend/src/app/core/` y `frontend/src/app/shared/` |
| Estado global | `frontend/src/app/store/` |
| Recursos AWS | `infra/cognito/lib/` |
| Pipeline | `.github/workflows/` |

## Limites que conviene conservar

- Los controladores obtienen el usuario de `@CurrentUser()`; nunca se acepta
  `userId` del cliente como autoridad.
- Los casos de uso dependen de interfaces/tokens, no de DynamoDB o MongoDB.
- Los repositorios deben mantener paridad funcional entre DynamoDB y MongoDB.
- La UI llama `/api` como origen relativo. CloudFront, Angular dev server o
  Express resuelven el salto al backend segun el entorno.
- Los cambios sensibles deben incluir la evidencia de privacidad exigida por
  `tools/require-privacy-review.mjs`.

## Zonas con deuda estructural

- `frontend/src/app/features/pantry/pantry-page.component.ts` y su plantilla
  concentran demasiadas responsabilidades y son el mayor punto de riesgo de UI.
- `backend/src/app.module.ts` es una composicion extensa con dos proveedores de
  persistencia; cualquier binding nuevo debe probar ambos caminos.
- Los documentos historicos de Dokploy no son un mecanismo de rollback. La
  entrega vigente usa artefactos inmutables, versiones/alias Lambda y S3
  versionado mediante los workflows serverless.
