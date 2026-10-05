# Riesgos y asuntos pendientes

> **SNAPSHOT HISTORICO — NO USAR COMO ESTADO OPERATIVO.** Este archivo conserva
> la evidencia y las preguntas abiertas observadas el 2026-08-31. Atomicidad,
> idempotencia, cuotas, paginacion, controles de entrega, MFA y recursos legados
> cambiaron despues de ese corte. El estado vigente y los pendientes reales
> quedan supersedidos por el informe final de produccion del 2026-09-26.

Fecha de corte: 2026-08-31.

## Bloqueadores antes de un lanzamiento publico

### Atomicidad e idempotencia

- Consumir un lote y guardar una merma no es atomico; un fallo parcial puede
  descontar sin evento o duplicar efectos al reintentar.
- Cerrar una compra crea varios lotes sin idempotency key; un retry puede
  duplicar compras y un fallo intermedio deja un checkout parcial.
- El borrado de cuenta cruza DynamoDB/Cognito sin checkpoint durable; es
  reejecutable en partes, pero no ofrece una garantia transaccional completa.

[ASK USER] Definir la semantica esperada: todo-o-nada, aceptacion de resultados
parciales y ventana de deduplicacion. La implementacion correcta depende de esa
decision de producto.

### Entrega y operacion

- Solo existe `prod`; no hay infraestructura desplegada para `dev` o `tst`.
- Los environments/variables de GitHub, proteccion de `main`, reviewers y rol
  AWS OIDC no estan configurados. Los workflows de despliegue no han operado.
- No hay WAF, access logs de API/CloudFront, alarmas, canary, dashboard ni
  runbook de incidentes/restauracion.
- Lambda no usa version/alias/canary; S3 no tiene versionado; stacks y tablas no
  tienen todas las protecciones contra borrado habilitadas en el estado actual.

[ASK USER] Elegir responsables, gates de promocion, RPO/RTO y presupuesto de
observabilidad antes de abrir el producto a usuarios reales.

### Capacidad y consistencia de inventario

- Las escrituras no imponen limites equivalentes a los topes de lectura. Un
  usuario puede acumular suficientes tipos/lotes para que los overview oculten
  registros por limites de consulta.
- Algunos indices compartidos aplican `Limit` antes de filtrar entidad/estado;
  con volumen alto pueden omitir lotes activos.
- La unicidad de nombres de `ProductType` y de membresia de hogar tiene ventanas
  de carrera.

[ASK USER] Definir limites comerciales por cuenta/hogar. Luego deben aplicarse
condiciones atomicas en escritura y paginacion completa en lectura.

## Riesgos altos ya corregidos en esta auditoria

- SSRF del proxy SSR por request-target absoluto o escapado.
- Estado offline/local visible entre cuentas distintas del mismo navegador.
- Enlaces legacy de listas que aceptaban contenido sin firma.
- Full table scans de listas, shares y hogar en request time.
- Callbacks/logout localhost sintetizados para Cognito `prod`.
- Confianza en `X-Forwarded-For` manipulable para rate limiting.
- Creacion/restauracion de lotes bajo tipos archivados.
- Crecimiento sin limite de dispositivos conocidos (tope actual: 25).
- Crash de UI al mostrar precio `null` y falso cierre offline si localStorage
  falla.
- Dependencias de runtime con advisories conocidos.

## Riesgos medios

- El limite de dispositivos evita nuevos registros despues de 25, pero no
  ofrece UI de revocacion individual ni politica de expiracion automatica.
- El rate limiter ya no confia en headers reenviados, pero falta demostrar que
  `request.ip` en Lambda conserva una identidad util por cliente; API Gateway
  directo sigue publico.
- La CSP permite `'unsafe-inline'` para scripts/estilos.
- El service worker es una implementacion manual con cobertura offline parcial.
- El componente principal de pantry es muy grande, lo que aumenta regresiones,
  bundle y costo de mantenimiento.
- Las fechas de compra/caducidad usan `Date` y pueden desplazarse por zona
  horaria cuando conceptualmente representan una fecha civil.
- Algunos mensajes muestran detalles tecnicos de error al usuario.
- La documentacion historica de Dokploy convive con la ruta serverless y puede
  inducir operaciones sobre recursos legados.

## Costos y activos legados

- El gasto mensual observado supera los budgets configurados ($32 y $40);
  durante la revision rondaba $74, principalmente por recursos compartidos de
  la cuenta, no solo esta aplicacion.
- Existen user pools antiguos `dev/prod`, parametros SSM y referencias Dokploy
  que no pertenecen a la topologia vigente.

[ASK USER] Autorizar de forma explicita que recursos legados se eliminan; no se
hicieron borrados destructivos durante la auditoria.

## Calidad visual y accesibilidad

- La UI responde bien en movil, tablet y escritorio y no mostro overflow.
- El gradiente de botones primarios ya cumple WCAG AA y tiene una prueba de
  contraste; algunos errores aun no estan asociados al campo mediante
  `aria-describedby`.
- El manifest solo declara un favicon 48x48, insuficiente para una instalacion
  PWA completa.

[TODO] Corregir asociaciones de error e iconos 192/512 antes de promocionar la
aplicacion como PWA instalable.

## Dictamen de este corte

El sistema esta funcional y el recorrido principal real funciona, pero aun no
debe considerarse listo para lanzamiento publico sin resolver atomicidad de
compras/consumo y habilitar una ruta de entrega/operacion controlada. Para una
beta privada de bajo volumen puede usarse con monitoreo manual y expectativas
explicitas sobre reintentos.
