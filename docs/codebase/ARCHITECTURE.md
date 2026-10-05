# Arquitectura

Este documento describe el contrato versionado. El estado exacto de cada
despliegue se registra en el informe final de produccion; una capacidad presente
en CDK o en un workflow no implica por si sola que ya este activa en `tst` o
`prod`.

## Topologia serverless

```text
Navegador
   |
Route53 + ACM
   |
CloudFront
   |-- contenido web --> S3 privado
   `-- /api/* ---------> API Gateway HTTP API --> Lambda Nest/Fastify
                                                   |-- Cognito
                                                   `-- DynamoDB (4 tablas)
```

La URL productiva actual es `https://despensalista.lynxpardelle.com`. Los
entornos versionados usan `dev.despensalista.lynxpardelle.com`,
`test.despensalista.lynxpardelle.com` y el dominio productivo. CloudFront
inyecta un secreto de origen que la API valida; la URL `execute-api` no es una
ruta alternativa de aplicacion.

El CDK intenta asociar el plan CloudFront `FREE` y su WAF incluido. AWS rechazo
la elegibilidad de las distribuciones no productivas durante el hardening, por
lo que el fallback versionado es CloudFront PAYG de bajo trafico, sin WAF de
pago y conservando la verificacion de origen. No se debe crear un WAF PAYG sin
nueva aprobacion de costo.

## Capas del backend

1. `domain`: entidades y reglas que no conocen Nest ni la base de datos.
2. `application`: casos de uso, puertos, servicios y read models.
3. `infrastructure/http`: autenticacion, DTOs, controladores y mapeo.
4. `infrastructure/database`: implementaciones DynamoDB y MongoDB.
5. `app.module.ts`: selecciona adaptadores con `PERSISTENCE_PROVIDER`.

La propiedad de datos se valida por el `sub` de Cognito convertido en
`UserId`. Los repositorios de hogar agregan acceso compartido y aplican fences
de borrado antes de aceptar escrituras relacionadas con una cuenta.

## Autenticacion y correo

1. El frontend pide proveedores a `/api/auth/cognito/providers`.
2. El backend crea una transaccion OAuth con state, nonce y PKCE y redirige al
   Managed Login de Cognito.
3. Cognito vuelve al callback del backend.
4. El backend intercambia el codigo, sincroniza el perfil local y entrega
   cookies HttpOnly/Secure.
5. `AccessTokenGuard` verifica JWT y `AuthStepUpService` protege operaciones
   destructivas.

Los tres pools se configuran con TOTP obligatorio para usuarios locales
(`MfaConfiguration=ON`). Google aplica su propia politica MFA. Todos mantienen
`COGNITO_DEFAULT`, sin `From` ni `SourceArn`, para usar la entrega administrada
de Cognito y su cuota de 50 mensajes diarios. SES/DKIM esta verificado para
`despensalista.lynxpardelle.com`, pero el remitente propio y el envio directo
`DEVELOPER` requieren que AWS apruebe acceso de produccion SES.

## Modelo de datos

- `User`: perfil local cuyo id coincide con el `sub` principal de Cognito.
- `ProductType`: tipo base, unidad y reglas de reposicion/durabilidad.
- `InventoryLot`: compra concreta, cantidad, fechas, precio y estado.
- `WasteEvent`: merma registrada al consumir un lote.
- `ShoppingList` y `ShoppingShare`: snapshots de compra y enlaces opacos.
- `Household`, membresias, invitaciones y actividad: registros de hogar en la
  tabla de usuarios mediante claves compuestas/GSI.
- `Product`: modelo legacy conservado para migracion y compatibilidad.

Las cuatro tablas fisicas son usuarios, productos legacy, tipos y lotes. La
tabla de lotes tambien almacena eventos de merma; la de usuarios almacena
perfil, preferencias, dispositivos, recibos/cuotas de pantry y entidades de
hogar/listas.

## Atomicidad, idempotencia y cuotas

`consume` y cierre de compra requieren un `Idempotency-Key` UUID. La primera
ejecucion almacena durante siete dias un recibo ligado a usuario, comando y hash
canonico de la solicitud. Un retry identico devuelve la misma respuesta sin
repetir efectos; reutilizar la llave con otro payload, o mientras persiste un
recibo ya vencido, devuelve conflicto.

- DynamoDB usa `TransactWriteItems`; MongoDB usa una transaccion de sesion y por
  eso requiere replica set.
- El consumo actualiza/elimina el lote, registra merma cuando corresponde,
  ajusta cuota y guarda el recibo como una sola unidad.
- El checkout crea lotes deterministas, actualiza metadata de tipos, ajusta
  cuotas y guarda el recibo como una sola unidad. El limite es 49 lineas para
  permanecer dentro de las 100 acciones de una transaccion DynamoDB.
- Altas, archivados, restauraciones y borrados aplican los mismos contadores y
  fences. Los limites vigentes viven en
  `backend/src/application/constants/query-limits.ts`.

Las colecciones acotadas exponen paginacion por cursor. Los recorridos internos
de limpieza consumen todas las paginas y las consultas productivas usan
claves/GSI; no dependen de un `Limit` que oculte registros despues de filtrar.

El borrado de cuenta no puede ser una unica transaccion entre DynamoDB y
Cognito. Se implementa como una operacion reintentable: primero levanta fences
en cuenta/pantry/hogar, luego limpia contenido y anonimiza referencias
historicas que deben conservarse, y al final elimina/cierra la identidad. El
marker minimo de revocacion expira tras 24 horas y evita que solicitudes ya
autorizadas recreen datos durante la limpieza.

## Entrega, rollback y recuperacion

- `dev` construye una vez el ZIP Lambda ARM64 y el frontend; el manifest fija
  hashes y `sourceSha`.
- `tst` y `prod` solo aceptan el merge de dos padres esperado y verifican que
  el arbol sea identico a la rama precedente. Promueven el mismo artefacto, no
  recompilan la aplicacion.
- Cada stage usa su environment GitHub, rol OIDC, bucket de assets, rol
  CloudFormation y permissions boundary aislados.
- Cada despliegue guarda un recibo con cuenta, region, stage, SHA, release,
  funcion/alias/version Lambda exactos, hashes de backend/frontend, bucket y
  distribucion. El rollback valida ese recibo antes de mover `live` y restaurar
  el frontend; no selecciona una version solo porque comparta el mismo ZIP.
- API/Lambda usan logs con retencion acotada. El diseno incluye cuatro alarmas
  productivas y smoke publico horario; CloudWatch Synthetics se excluyo por
  costo.
- El ensayo del 2026-09-25 restauro las cuatro tablas a un mismo punto,
  comparo conteos, esquemas e hashes y elimino las copias temporales. Ver
  `docs/reviews/2026-09-25-recovery-rehearsal.md`.

El runbook operativo vigente es `docs/operations/production-runbook.md`. Los
documentos Dokploy/EC2 son evidencia historica y no constituyen una ruta de
despliegue ni rollback.
