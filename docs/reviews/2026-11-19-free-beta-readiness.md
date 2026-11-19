# Revisión de beta Gratis — 19 de noviembre de 2026

Alcance: preparar una beta controlada de cinco hogares. Las ventas de Plus Hogar
permanecen cerradas; esta revisión no autoriza abrir Checkout ni habilitar los
avisos de renovación. La aprobación de SES sigue pendiente y pertenece al
lanzamiento comercial de Plus.

## Estado comprobado

- Producción sirve el release `1ce2f3a3af1f`, alias `live` v16 y contrato de datos
  4. Ambos controles de Checkout están en `false`; el cambio de hogar está
  habilitado.
- El smoke público de `https://despensalista.com` pasó. La portada, planes,
  dominio `www`, API y manifiesto responden. En navegador interno se observaron
  los planes, el aviso de apertura pendiente de Plus y el formulario con Error,
  Queja y Sugerencia. La sesión existente abrió su despensa; no se modificaron
  sus datos ni se envió un reporte ficticio con ella.
- Las cinco alarmas estaban en `OK`, con acciones habilitadas y un destinatario
  de operaciones confirmado. El monitor programado de producción pasó hoy en
  la [ejecución 44612084585](https://github.com/LynxPardelle/despensalista/actions/runs/44612084585).
- La reanudación del borrado de cuentas está habilitada cada quince minutos y
  apunta al alias publicado. Esta consulta verifica configuración, no un fallo
  inducido del worker en AWS.
- Cognito usa su remitente administrado, MFA nativo obligatorio y recuperación
  mediante correo verificado. La cuota observada es 30 correos por ventana,
  con 10 reservados para recuperación y 5 por destinatario. La ventana reinicia
  a las 09:00 UTC. SES sandbox no bloquea este flujo de alta.
- Los registros MX y del servidor de correo mantienen HostGator como destino.

## Correcciones del candidato

1. El enlace de teclado «Ir al contenido» de `/planes` llevaba a la portada.
   La prueba E2E reprodujo esa navegación incorrecta antes de la corrección;
   ahora conserva `/planes#contenido`.
2. La ayuda de Perfil exigía retirar a un integrante antes de cambiar de hogar.
   Ahora explica la invitación y confirmación y la condición de hogar sin uso
   para el titular. Los datos conservan su hogar de origen.
3. Perfil mostraba cincuenta renglones por cierre. La ayuda ahora informa los
   límites efectivos de 49 renglones y 48 tipos distintos.
4. Se guardaron la [guía de invitación y operación](../operations/beta-gratis-cinco-hogares.md)
   y la [tabla H01–H05](../operations/beta-gratis-seguimiento.csv). La tabla está
   vacía de resultados y datos personales; cada hogar comienza pendiente.

Se conserva también el cambio de arnés previamente usado para probar códigos de
acceso en producción: exige `--run-production-fixtures`, verifica el entorno y
Checkout cerrado y utiliza identidades propias desechables. No cambia el runtime.

## Evidencia de pruebas

| Prueba | Resultado y alcance |
| --- | --- |
| Backend focalizado | 13 suites / 161 pruebas correctas: hogar, origen de compras, cuotas, idempotencia, planes, reportes, autenticación y borrado/reanudación. |
| Backend build | Correcto. |
| Frontend Angular | 232 pruebas correctas. |
| Frontend build | Correcto, con prerender de 14 rutas. |
| Android emulado | 9 E2E correctas. |
| WebKit con iPhone emulado | 9 E2E correctas. |
| Automatización y arneses | 88 pruebas correctas: despliegue, rollback, validación de promociones, smoke, códigos de acceso y salud de réplica. |
| API desplegada en dev | 11 comprobaciones correctas, incluida limpieza. |
| API desplegada en tst | 11 comprobaciones correctas, incluida limpieza. |
| API desplegada en prod | 11 comprobaciones correctas, incluida limpieza. |

Los tres recorridos de API usan el script
`backend/scripts/deployed-api-smoke.cjs --stage <stage> --run`, con cuentas
generadas y mensajes de Cognito suprimidos. Comprueban SRP y TOTP, protección del
origen, tipos y lotes, consumo/merma y reintentos concurrentes, cierre de compra,
límites, paginación, archivo y borrado. No sustituyen la recepción de correo ni
el callback OAuth en un navegador. En producción el arnés usa el alias histórico
del mismo CloudFront; el smoke público y la inspección de navegador usan
`despensalista.com`.

Las E2E móviles usan respuestas controladas en los flujos de acceso y reportes.
La instalación y apertura físicas en iPhone y Android, la recuperación de
contraseña con retorno a la despensa y la primera compra/reapertura cuentan con
confirmación anterior del usuario; no se presentan como nuevas pruebas físicas
de esta ronda ni como aceptación de los cinco futuros hogares.

La suite backend completa y e2e local con MongoDB se interrumpieron al agotarse
la memoria disponible de Windows y vencer el arranque de MongoMemoryServer. No
se interpretan como un fallo de negocio. Tras liberar procesos, el build y las
161 pruebas focalizadas pasaron. La CI debe completar sus comprobaciones antes
de promover el candidato.

## Pendientes de la ronda

- Elegir quién revisará cada día la bandeja de folios y las alarmas, y registrar
  ese responsable en la copia privada de la tabla. El formulario guarda reportes
  con folio; no envía avisos por correo.
- Compartir las invitaciones manualmente y completar las casillas de H01–H05
  con resultados reales. Empezar con dos hogares y continuar con tres cuando
  los primeros completen alta y primera compra.
- Conservar el reporte menor de «Mostrar contraseña» en Cognito/Safari: el
  usuario completó la recuperación, pero la casilla no reveló el texto. No hay
  causa aislada ni corrección acreditada para esa pantalla administrada por AWS.
- El build mantiene advertencias de tamaño: bundle inicial de 505.80 kB frente
  al umbral de aviso de 500 kB, y CSS de despensa/marketing ligeramente mayores
  de 4 kB. La compilación pasa; no se aumentaron los presupuestos para ocultarlas.

No se detectó un bloqueo técnico nuevo para esta beta controlada. Antes de
ampliarla deben pasar alta, primera compra y retorno de los cinco hogares, y
colaboración en aquellos que inviten a un segundo integrante. Mantener la
aceptación comercial de Plus separada de estos resultados.
