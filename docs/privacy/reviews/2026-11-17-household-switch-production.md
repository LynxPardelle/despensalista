# Publicación del cambio de hogar

El cambio conserva las compras, el inventario y la facturación en sus hogares de origen. La cuenta que acepta una invitación confirma el hogar de salida y el de destino. La membresía y el canje quedan en la misma transacción. El identificador guardado con la compra pendiente se comprueba al registrar el cierre. Una compra antigua sin origen comprobable se conserva localmente para revisión.

El hogar automático de un titular se puede cerrar solo si tiene un integrante y el servidor conserva prueba de que sigue sin uso. Una vez que se registra uso, la elegibilidad queda invalidada aunque se suspendan nuevos cambios de hogar. Los hogares anteriores sin evidencia suficiente se conservan.

El manifiesto y la infraestructura pasan al contrato de datos 3. El mecanismo de recuperación permite volver a la versión capturada mientras las escrituras siguen detenidas durante la publicación. Una vez reabiertas, las reversiones requieren una versión que valide el origen de las compras y aplique la membresía vigente.

La verificación desplegada usa hogares e identidades temporales generados para cada ambiente. Cognito suprime los mensajes de alta y la prueba verifica la eliminación de las identidades y de sus registros de cambio al terminar. El flujo se verifica como Gratis, con las ventas de Plus Hogar cerradas en producción.
