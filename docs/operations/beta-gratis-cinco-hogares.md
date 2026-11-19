# Beta de Gratis: primeros cinco hogares

La beta usa https://despensalista.com y el plan Gratis: hasta dos integrantes por
hogar y tres listas reutilizables. No requiere tarjeta. Las ventas de Plus Hogar
permanecen cerradas. Esta guía organiza una beta por invitación; no agrega una
restricción de acceso al sitio ni envía invitaciones automáticamente.

## Mensaje para invitar

> Estamos probando DespensaLista con cinco hogares y nos gustaría que el tuyo
> participe. Puedes registrar lo que compras, revisar caducidades y preparar la
> siguiente lista con otra persona de tu hogar.
>
> La beta es gratuita, no pide tarjeta y permite hasta dos integrantes y tres
> listas guardadas. Abre https://despensalista.com, elige «Empieza gratis» e inicia
> con Google o crea una cuenta con tu correo. Si usas correo, confirma el mensaje
> y guarda el acceso a tu autenticador.
>
> Para empezar, registra una compra pequeña de tres productos. Cierra y vuelve a
> abrir la app para comprobar que siga allí. Luego invita, si quieres, a la otra
> persona desde Perfil. Comparte el enlace de invitación de ese hogar solo con su
> destinatario.
>
> Puedes instalarla desde Safari → Compartir → Agregar a inicio en iPhone, o
> Chrome → menú → Instalar aplicación en Android. Para sincronizar y entrar
> necesitas conexión; algunos borradores se conservan en ese dispositivo.
>
> Si algo falla, toca «Reportar un problema» y compártenos el folio. También
> puedes enviar una queja o sugerencia desde el formulario. Evita incluir
> contraseñas, códigos, datos fiscales o de pago. Al terminar nos gustaría saber
> qué te resultó útil y en qué paso te atoraste.

El operador comparte este texto de forma manual. La invitación a esta beta y el
enlace privado para incorporarse a un hogar son cosas distintas: cada titular
genera este último desde Perfil, dirigido al correo de su segundo integrante.

## Preparación del operador

1. Asignar una persona que revise los folios y alarmas cada día; registrar su
   nombre en la copia privada del seguimiento. Confirmar quién la sustituye.
2. Copiar [el seguimiento de cinco hogares](beta-gratis-seguimiento.csv) a una
   hoja privada. En el repositorio solo se guardan los alias H01–H05; los nombres,
   correos y enlaces de invitación pertenecen a esa copia privada.
3. Comprobar el último [Production Smoke](https://github.com/LynxPardelle/despensalista/actions/workflows/production-smoke.yml)
   y las cinco alarmas de producción. Seguir el
   [runbook](production-runbook.md) ante un fallo.
4. Empezar con dos hogares y continuar con los tres restantes cuando ambos puedan
   entrar y completar una primera compra. No abrir una campaña pública durante
   esta primera ronda.
5. Contabilizar las altas y reenvíos por correo: el guard de producción admite
   treinta mensajes por ventana diaria, con diez reservados para recuperación y
   cinco por destinatario. La ventana cambia a las 09:00 UTC (03:00 en Ciudad de
   México). Cinco hogares con dos integrantes usan hasta diez mensajes
   iniciales si todos eligen correo. Los reenvíos y otras altas también consumen
   el cupo; no prometer entregas ilimitadas ni subir la cuota para esta ronda.

Google y una cuenta por contraseña son métodos distintos. Una cuenta creada solo
con Google usa «Entrar con Google». La recuperación de contraseña requiere una
cuenta nativa cuyo correo ya esté confirmado. La guía de acceso ayuda a elegir el
método. La aprobación de SES para renovaciones de Plus no bloquea el correo
administrado por Cognito que usa esta beta.

## Recorrido y criterio de aceptación

Cada hogar comienza con estado «Pendiente»; una prueba técnica o de otro hogar no
cuenta como su aceptación. Usar `OK`, `Bloqueado` o `No aplica`, con fecha y folio
cuando corresponda.

| Paso | Resultado que debe comprobar el hogar |
| --- | --- |
| Alta y acceso | Puede entrar y ver su propia despensa. Si eligió correo, recibió y confirmó el código. |
| Primera compra | Registra tres productos con cantidad y, al menos para uno, caducidad; al reabrir sigue una sola compra, sin duplicados. |
| Consumo y merma | Consume parte de un lote y marca una cantidad de otro como merma; las existencias reflejan ambas acciones. |
| Lista | Guarda una lista y vuelve a abrirla; el límite de Gratis es de tres listas. |
| Colaboración | El segundo integrante acepta su enlace, ve esa misma despensa y puede colaborar según su rol. El hogar no debe mostrar datos ajenos. |
| Cambio de hogar | Si corresponde, confirma origen y destino. Los datos y las compras pendientes conservan su hogar de origen. Un titular con actividad no puede cerrar su hogar como si estuviera vacío. |
| Instalación y retorno | El icono abre la app en el teléfono; tras cerrarla, volver a entrar conserva los datos sincronizados. |
| Recuperación | Si usa contraseña, puede recuperarla con el correo confirmado y volver a la despensa. Los códigos se ingresan solo en Cognito. |
| Reportes | Encuentra el formulario y, si detectó un problema o quiere sugerir algo, recibe un folio al enviarlo. No exigir un reporte ficticio a todos. |

Antes de ampliar la beta, los cinco hogares deben completar alta, primera compra
y retorno, y cada hogar que invitó a alguien debe completar colaboración. Resolver
antes cualquier pérdida o mezcla de datos, bloqueo de acceso, duplicado de compra
o fallo de seguridad. Para errores menores, conservar folio, responsable y estado.
Una muestra de cinco hogares prueba uso inicial; no acredita capacidad para una
campaña masiva.

## Seguimiento de problemas

Consultar la [bandeja de reportes](dev-feedback-inbox.md), que funciona sin SES y
no envía notificaciones por correo. Un folio debe registrarse con el alias del
hogar, dispositivo, paso, síntoma, prioridad y responsable. Mantener el texto y
cualquier dato personal en la herramienta privada, no en commits ni capturas
públicas.

- Acceso bloqueado o posible pérdida/mezcla de datos: pausar nuevas invitaciones y
  revisar el incidente antes de continuar.
- Error funcional con alternativa: dar una indicación temporal y registrar la
  corrección pendiente.
- Queja o sugerencia: registrar como tal, sin presentarla como defecto confirmado.

Al cerrar la ronda, anotar cuántos hogares completaron cada paso, los folios
abiertos y la decisión de continuar, corregir o pausar. Este registro no habilita
Checkout ni cambia las condiciones de Plus Hogar.
