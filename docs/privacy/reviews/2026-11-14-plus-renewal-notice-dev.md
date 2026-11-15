# Aviso de renovación de Plus Hogar en dev

La cola de dev se crea a partir de la suscripción mensual del hogar en el sandbox de Stripe. El aviso vence siete días naturales antes de la renovación según el calendario de Ciudad de México. Antes de enviar, la aplicación vuelve a consultar la suscripción y la cuenta propietaria. El texto incluye el importe del plan, la fecha de renovación y el acceso a Perfil para gestionar la suscripción.

La cola conserva los identificadores de hogar y suscripción, la fecha de renovación y el resultado del intento durante su ventana de retención. Resuelve la dirección verificada desde Cognito al enviar. El código y los registros operativos excluyen direcciones de los mensajes de diagnóstico. SES recibe el destinatario y el texto del aviso. IAM limita el envío al remitente de DespensaLista y al único buzón de prueba autorizado.

El recurso y la regla programada se habilitan en dev mediante la configuración del entorno. Los escenarios de prueba usan suscripciones desechables. El reloj de prueba se acepta por invocación directa de la Lambda de dev y exige el identificador de un único aviso. El recorrido productivo conserva Checkout cerrado.

La cola registra cada intento para evitar reenvíos ante reintentos o respuestas inciertas de SES. Consultar [el runbook](../../operations/production-runbook.md) antes de habilitar el servicio para clientes reales.

Para diagnosticar rechazos en dev, el transporte registra solamente una categoría de error de una lista fija y, si existe, el código HTTP. Se descartan la excepción completa, destinatarios, contenido y metadatos de la solicitud. El registro no habilita nuevos envíos ni cambia cuándo se permite reintentar un aviso.
