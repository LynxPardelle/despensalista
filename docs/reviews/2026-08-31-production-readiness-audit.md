# Auditoria de preparacion para produccion

> **CORTE HISTORICO.** Este dictamen registra el estado observado el 2026-08-31
> y no es el estado operativo actual. Sus bloqueadores y recursos pendientes
> quedan supersedidos por el informe final de produccion del 2026-09-26; se
> conserva sin reescribirlo como evidencia de la auditoria original.

Fecha: 2026-08-31
Aplicacion: Despensa Lista
Entorno revisado: repositorio completo y AWS `prod` en `us-east-1`

## Dictamen ejecutivo

**No recomiendo todavia un lanzamiento publico general.** El producto ya es
utilizable y el recorrido principal funciona de extremo a extremo, pero quedan
dos clases de bloqueo:

1. Las operaciones de consumo/merma y cierre de compra no tienen semantica
   atomica ni idempotente. Un retry puede duplicar o dejar resultados parciales.
2. La ruta de entrega y operacion no esta activa: solo existe `prod`, no hay
   rol OIDC/environments/gates de GitHub, proteccion de rama, alarmas, access
   logs, canary ni rollback por alias de Lambda.

El sistema si puede operar como **beta privada de bajo volumen**, con monitoreo
manual y usuarios informados de no reintentar ciegamente una compra/consumo que
termine con error. La correccion puntual de callbacks Cognito se desplego y
verifico; las correcciones de runtime de frontend/backend estan en el working
tree y no llegaran a produccion hasta ejecutar un release controlado.

## Alcance y metodo

- Inventario del arbol completo y documentacion de arquitectura/codigo.
- Revision independiente de backend, frontend/UX, autorizacion/seguridad e
  infraestructura/operacion.
- Instalaciones reproducibles, lint, unitarias, e2e, builds y sintesis CDK.
- Auditoria de dependencias de runtime de los tres paquetes.
- Inspeccion visual responsive y de accesibilidad en navegador.
- Inspeccion read-only de AWS, CloudWatch, DynamoDB, Cognito, CloudFront,
  API Gateway, Lambda, S3, CloudFormation, budgets y GitHub.
- Prueba real autenticada en produccion con un usuario Cognito temporal:
  creacion, login, alta de tipo/lote, perfil, detalle y borrado de cuenta.
- Verificacion posterior de que el usuario y todos sus registros fueron
  eliminados. No quedan credenciales ni datos de esa prueba.
- Scan de seguridad sellado `93473932-9cec-4af8-afa5-e9b2a81972f5`: 9 hallazgos
  pre-remediacion (2 altos, 5 medios, 2 bajos), cobertura parcial enfocada en
  superficies de mayor riesgo.

No se ejecutaron pruebas destructivas de carga, restore PITR, failover ni
eliminacion de recursos legados.

## Estado productivo observado

```text
Route53 / ACM
      |
CloudFront
      |-- S3 privado (Angular estatico)
      `-- /api --> API Gateway HTTP API --> Lambda Node 22 ARM64
                                             |-- Cognito
                                             `-- 4 tablas DynamoDB
```

- URL canonica: `https://despensalista.lynxpardelle.com`.
- Health de frontend y backend: HTTP 200.
- Login Cognito local y Google: disponibles.
- El app client productivo ya contiene exclusivamente callback/logout HTTPS del
  dominio canonico; la eliminacion de localhost se desplego por CloudFormation
  y el login se reverifico con respuesta 302 al dominio administrado.
- API no autenticada: rechaza pantry con 401.
- En siete dias: cero errores/throttles Lambda y cero 5xx API, con trafico muy
  bajo; esto prueba salud basica, no capacidad.
- DynamoDB tiene PITR; S3 no tiene versionado.
- El endpoint `execute-api` es publico y evita CloudFront.
- No hay WAF, logs de acceso, alarmas, dashboard, canary ni health check externo.
- Solo se encontraron stacks `prod`; no existen `dev` o `tst` desplegados.
- El gasto observado rondaba USD 74 frente a budgets de USD 32 y USD 40. La
  cuenta contiene recursos compartidos, por lo que no todo el gasto pertenece
  a Despensa Lista.
- Hay pools Cognito, SSM y referencias Dokploy legadas. No se eliminaron porque
  requieren autorizacion exacta y un plan de rollback.

## Correcciones realizadas

### Seguridad y aislamiento

- El proxy SSR ahora fija el origin del backend y rechaza request-targets
  absolutos, protocol-relative, backslashes, controles y escapes de ruta.
- Todo el estado local/offline de pantry usa envelopes versionados por user id;
  no se muestra ni sincroniza informacion de otra cuenta del navegador.
- Se eliminaron los shares legacy sin firma; errores de red/5xx ofrecen retry.
- Los redirects post-login rechazan backslashes y controles.
- Cognito `prod` deja de sintetizar callbacks/logout localhost.
- El rate limiter productivo deja de confiar en `X-Forwarded-For` arbitrario.
- Se limita a 25 la creacion de dispositivos conocidos por usuario.

### Integridad funcional y datos

- Precios `null`, `NaN` o infinitos ya no rompen la vista.
- Si localStorage falla durante un checkout offline, el modo compra permanece
  abierto y no informa un cierre inexistente.
- No se pueden crear/restaurar lotes bajo un tipo archivado.
- `SignOutAllSessionsDto` conserva y valida su confirmacion bajo ValidationPipe.
- Se retiraron full table scans de request-time para hogares, listas y shares;
  antes se verifico en `prod` que los registros vigentes tienen sus claves GSI.
- El borrado de privacidad incluye datos legacy y pagina eventos de merma sin
  truncarlos (verificacion final del backend incluida en la matriz).

### Dependencias, pruebas y documentacion

- Angular/Express, Nest/Fastify/Swagger/Mongoose y AWS CDK se actualizaron a
  versiones auditadas compatibles.
- Se restauro `@fastify/static`, requerido por Swagger, con un e2e de regresion.
- Los tres paquetes reportan cero vulnerabilidades conocidas de runtime.
- Los fixtures Playwright se alinearon al contrato actual y la suite vuelve a
  pasar completa.
- Los colores de acciones primarias ahora superan contraste WCAG AA y tienen
  una regresion automatizada.
- Se agrego `docs/codebase/` con stack, estructura, arquitectura, convenciones,
  integraciones, pruebas y riesgos actuales.

## Matriz de verificacion

| Area | Comando/prueba | Resultado |
| --- | --- | --- |
| Backend | `npm ci` | Pasa |
| Backend | `npm run lint:check` | Pasa |
| Backend | `npm test -- --runInBand` | Pasa; 57 suites, 215 pruebas |
| Backend | `npm run test:e2e -- --runInBand` | Pasa; 4/4 (root, health, metrics y Swagger) |
| Backend | `npm run build` | Pasa |
| Frontend | `npm ci` | Pasa |
| Frontend | `npm test -- --no-progress` | Pasa; 133/133 |
| Frontend | `npm run build` | Pasa; 10 rutas, sin budget warnings |
| Frontend | Playwright | Pasa; 5/5 |
| Infra | `npm ci`, build y `node:test` | Pasa; 4/4 pruebas |
| Infra | synth `dev`, `tst`, `prod` | Pasa |
| Runtime deps | `npm audit --omit=dev` en 3 paquetes | 0 vulnerabilidades |
| Tooling frontend | `npm audit` completo | 7 advisories transitivos solo de build/dev; no hay fix seguro sin downgrade mayor |
| Docker/Trivy | Build local | No ejecutado: Docker no disponible en el host |
| Produccion real | login, CRUD minimo, perfil y delete-account | Pasa y datos temporales eliminados |

## Asuntos que requieren decision

### 1. Semantica de compras y consumo — bloqueante

Decidir si el negocio exige todo-o-nada o acepta un resultado parcial. Recomiendo:

- `Idempotency-Key` por cierre de compra, resultado persistido y ventana de
  deduplicacion de al menos 24 horas.
- Transaccion DynamoDB para descontar lote + guardar merma, con condicion sobre
  version/cantidad.
- UI que consulte el resultado previo despues de timeout antes de reintentar.

### 2. Limites comerciales y paginacion — bloqueante al crecer

Las lecturas tienen topes, pero las escrituras aun permiten superarlos. Elegir:

- hard quotas por cuenta/hogar, aplicadas atomicamente; o
- paginacion real y export completo sin presentar los topes como cuotas.

Tambien se necesita resolver unicidad concurrente de tipos/membresias.

### 3. Promocion y propiedad operativa — bloqueante

Definir:

- cuentas/stacks de `dev`, `tst`, `prod`;
- reviewers de produccion y proteccion de `main`/ramas de promocion;
- rol GitHub OIDC de minimo privilegio y eliminacion de credenciales IAM largas;
- responsable de incidentes y rollback.

### 4. Observabilidad, seguridad de borde y recuperacion

Elegir RPO/RTO, retencion de logs, umbrales y canal de alertas. Recomiendo antes
del publico:

- access logs API/CloudFront, alarmas Lambda/API/Dynamo y synthetic canary;
- WAF/throttling de borde o una forma de impedir el bypass directo de API;
- alias/version de Lambda con rollback y S3 versioning;
- ensayo de restore PITR en `tst` y runbook.

### 5. Identidad, correo y activos legados

- MFA `OPTIONAL` u `ON`.
- SES/dominio de correo para entrega y reputacion.
- decidir que pools/parametros/infra Dokploy se conservan o eliminan.
- aprobar la limpieza solo despues de exportar inventario y confirmar que no es
  una via de rollback.

## Pendientes no bloqueantes de producto

- Dividir el componente pantry, que concentra logica y una plantilla grande.
- Mejorar asociaciones `aria-describedby` e iconos PWA 192/512.
- Modelar fechas civiles sin desplazamiento por timezone.
- No mostrar mensajes tecnicos de HTTP/persistencia directamente al usuario.
- Hacer hermetico Playwright: hoy el SSR/dev proxy puede registrar intentos de
  API antes de que `page.route` intercepte, aunque los cinco tests pasan.
- Definir politica para advisories transitivos del toolchain frontend.

## Criterio de salida recomendado

Antes de declarar GA:

1. Semantica idempotente/atomica implementada y probada.
2. `dev` y `tst` desplegados; promocion OIDC pasa hasta `prod` con approval.
3. Observabilidad/rollback/restore verificados.
4. Smoke autenticado sobre la version candidata.
5. Scan de seguridad de seguimiento sin hallazgos altos y con los medios
   aceptados o corregidos.
6. Decisiones anteriores registradas con responsable y fecha.

Para una beta privada, aceptar por escrito los puntos 1 y 2, limitar usuarios y
mantener monitoreo manual diario.
