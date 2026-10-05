# Estrategia de pruebas

## Backend

- Unitarias/integracion ligera: Jest, archivos `backend/src/**/*.spec.ts`.
- API e2e: Jest + Supertest en `backend/test`.
- Repositorios DynamoDB se prueban con clientes simulados y deben verificar
  expresamente las claves/indices usados.
- Comandos:

```powershell
cd backend
npm ci
npm run lint:check
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run build
npm audit --omit=dev --audit-level=low
```

## Frontend

- Unitarias: Karma/Jasmine en ChromeHeadless.
- E2E: Playwright; los recorridos mockean API cuando buscan probar UI estable.
- Build productivo incluye prerender y genera la carpeta estatica usada por
  CDK.
- Comandos:

```powershell
cd frontend
npm ci
npm test -- --no-progress
npm run build
npm audit --omit=dev --audit-level=low
```

Playwright no inicia un `webServer` por si mismo. Arranca primero la aplicacion
en otra terminal y luego apunta la suite a esa URL:

```powershell
# Terminal 1
cd frontend
npm start -- --port 48676

# Terminal 2
cd frontend
$env:E2E_BASE_URL='http://localhost:48676'
npm run test:e2e
```

## Infraestructura

- `node:test` + assertions CDK validan callbacks de Cognito y variables Lambda.
- `cdk synth` debe pasar para `dev`, `tst` y `prod`; el build del frontend debe
  existir antes de sintetizar la app serverless.
- Comandos:

```powershell
cd infra/cognito
npm ci
npm run build
node --test --require ts-node/register test/*.test.ts
npm run synth:dev
npm run synth:tst
npm run synth:prod
npm audit --omit=dev --audit-level=low
```

## CI y seguridad

- `.github/workflows/ci-cd.yml` agrega CodeQL, gitleaks, Trivy, contratos de
  release/rollback y una prueba real de transacciones MongoDB en replica set.
- `tools/require-privacy-review.mjs` bloquea cambios sensibles sin evidencia.
- `backend/scripts/deployed-api-smoke.cjs` es una prueba manual mutante por
  stage: crea un usuario Cognito temporal con TOTP, valida atomicidad,
  idempotencia, cuotas, paginacion y borrado, y limpia su fixture.
- La auditoria de seguridad formal de 2026-08-31 es evidencia historica; cada
  release de hardening debe producir un scan de seguimiento sobre su diff.

## Cobertura y huecos

- No existe un umbral de cobertura versionado ni publicacion de resultados.
- Los E2E no prueban de forma automatica Cognito real en CI; el flujo real se
  valido manualmente con un usuario temporal durante la auditoria y se limpio.
- No hay pruebas destructivas de carga ni chaos.
- El restore PITR de las cuatro tablas se ensayo y verifico en 2026-09-25; no
  mide un RTO completo de aplicacion ni sustituye ensayos periodicos.
- El smoke autenticado se ejecuta manualmente contra cada release para evitar
  conservar credenciales/cuentas QA. El smoke publico horario de GitHub cubre
  disponibilidad sin el costo de CloudWatch Synthetics.
- Las alarmas y su retencion se validan por sintesis y contra AWS; la entrega
  de notificaciones requiere una suscripcion SNS confirmada por un operador.
