# Revisión de privacidad de Gratis, Plus Hogar y reportes

La promoción utiliza el mismo artefacto en dev, tst y producción. La prueba de Checkout usa el sandbox exclusivo de DespensaLista en dev y una cuenta desechable. En tst se verifican los cupos y el formulario sin conexión a Stripe. En producción se conserva la facturación existente y Checkout permanece cerrado.

## Planes y resumen

- El plan se obtiene del registro de facturación del hogar asociado a la sesión autenticada. Contiene nivel, cupos y vencimiento. Para calcularlo se consulta la base de datos de la aplicación sin compartir información de inventario, merma ni listas con Stripe.
- El resumen semanal verifica el plan y el acceso antes de consultar despensa, merma y gasto. La respuesta no admite caché compartida. Los consumos y compras manuales, la exportación y la eliminación de datos están disponibles en ambos planes. Al volver a Gratis, el hogar conserva sus miembros, listas y despensa existentes, sujeto a los permisos vigentes de cada miembro.
- El cierre de compra agrega al registro de cuota del propietario el importe pagado y el número de renglones con y sin precio, por mes civil de Ciudad de México. El agregado queda en la misma transacción idempotente que el cierre y se elimina junto con los datos de despensa. El cálculo empieza con las compras cerradas en esta versión. Excluye renglones sin precio pagado y evita reconstruir importes pasados desde precios de referencia actuales.

## Reportes de bugs, quejas y sugerencias

- El formulario requiere iniciar sesión y protege la escritura contra solicitudes de otro origen. Pide categoría y texto breve. Indica que se eviten contraseñas, datos bancarios y datos personales. Guarda folio y fecha, sin correo, IP, identificadores de dispositivo ni archivos adjuntos. Usa una partición seudónima por cuenta para límites y borrado.
- El límite es de cinco reportes por cuenta y día UTC. El contador vence en 48 horas y los reportes en 90 días a través de TTL de DynamoDB. DynamoDB elimina registros vencidos de forma asíncrona. La consulta de operación excluye los vencidos y muestra únicamente folio, fecha, categoría y texto.
- Cada entorno tiene una bandeja y permisos de escritura propios. Solamente personal con permisos de AWS accede a la bandeja del entorno correspondiente. El borrado de cuenta elimina reportes y contadores. El flujo durable de producción reintenta un fallo de almacenamiento. [Consulta de la bandeja de reportes](../../operations/dev-feedback-inbox.md)
