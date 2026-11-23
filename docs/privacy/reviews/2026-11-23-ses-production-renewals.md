# SES: avisos de renovación y feedback de entrega

23 de noviembre de 2026. Preparación de la habilitación; este documento no acredita
un despliegue ni la recepción de un correo de cliente.

AWS aprobó el caso DespensaLista `179454466900956` el 21 de noviembre a las
19:08 UTC (13:08 de Ciudad de México). La consulta regional del 23 de noviembre
confirmó producción SES habilitada, envío habilitado y estado saludable, con
50,000 destinatarios diarios y 14 por segundo. La capacidad es compartida por la
cuenta y región; no se modifica la metadata del caso previo de Moyra ni sus
identidades, listas o destinos. Las ventas públicas de Plus Hogar permanecen
cerradas.

El aviso usa el remitente existente
`no-reply@despensalista.lynxpardelle.com`, cuya identidad y DKIM RSA-2048 están
verificados. El destinatario se resuelve desde el titular activo del hogar,
requiere un correo confirmado por Cognito y una renovación Stripe vigente. El
contenido incluye importe y fecha de renovación y cómo gestionar o cancelar la
suscripción. No incluye contraseña, códigos de acceso, datos fiscales, tarjeta,
inventario ni promociones. No es una lista comercial ni una campaña masiva.

La primera prueba tras salir del sandbox debe usar Stripe Sandbox y una cuenta
de prueba dedicada, con destino controlado que no esté verificado en SES. El
destinatario fijo de dev debe coincidir en Lambda, política inline y permissions
boundary, sin ampliar la concesión separada de CFDI. Se comprueban la ausencia de
envío a ocho días, una sola recepción a siete días naturales de Ciudad de México,
deduplicación y supresión al cancelar. Los ajustes de reloj solo se aceptan en
dev para un aviso exacto. Un identificador de mensaje de SES acredita aceptación
por el servicio, no recepción en el buzón.

Producción utiliza el mismo remitente regional y resuelve cada titular en el
servidor; no acepta un destinatario de prueba fijo. El bootstrap administrativo
prepara la permissions boundary y los permisos de lectura de disponibilidad,
despliegue y regla horaria. El worker sigue verificando cuota, suscripción y
ventana de entrega y limita el lote a cinco. Los avisos aceptados o inciertos no
se reabren para reintentar sin conciliación. El backend se instala por la
promoción protegida existente con Checkout cerrado. Cognito continúa usando su
remitente administrado; no se cambia el flujo de alta o recuperación para enviar
estas renovaciones.

La supresión de rebotes duros y quejas está habilitada en SES. El 23 de noviembre
se configuró el destino operativo para ambos eventos en el tema SNS Standard
existente `despensalista-prod-operations-alarms`, que ya tiene una suscripción de
correo confirmada. La nueva concesión de publicación permite solo al servicio
`ses.amazonaws.com`, para la identidad exacta de DespensaLista y la cuenta
`765932874577` en `us-east-1`. Se conservan los permisos actuales de alarmas;
no se reutilizaron los configuration sets de Moyra ni se crearon suscripciones nuevas.

Los eventos de feedback excluyen las cabeceras originales. Todavía pueden
contener direcciones de destino, identificadores de mensaje y diagnóstico del
rebote o queja. Dos eventos de simulador, uno de rebote y otro de queja, llegaron
al buzón operativo existente; los mensajes se conservaron sin leer. La
comprobación regional confirmó ambos temas y la exclusión de las cabeceras
originales. Esa información se usa para
investigar la entrega y mantener los destinos suprimidos; no debe publicarse en
logs, reportes abiertos o comentarios de GitHub. No se agrega una base de datos o
retención de payloads de correo en la aplicación. Debe probarse con los buzones
simuladores oficiales de SES, nunca provocando rebotes o quejas a una persona.

La asignación de temas se mantiene como configuración administrativa durable de
la identidad SES, con procedimiento versionado en el runbook y verificación tras
despliegues posteriores. Tras comprobar ambos simuladores en el buzón operativo,
se desactivó el forwarding de correo solo para esta identidad de DespensaLista,
conservando SNS como canal de feedback confirmado y evitando duplicados. No se
modificó el forwarding de otras identidades. No se habilitan notificaciones de
cada entrega exitosa.

El [runbook](../../operations/production-runbook.md#ses-approval-blocker) contiene
el bootstrap acotado, las verificaciones y los pasos de pausa. Esta preparación
no crea un plan SES de cuota fija, IP dedicada, nuevo tópico, cola o Lambda de
feedback. El envío SES y las notificaciones SNS conservan costo por uso; el
modelo de piloto y sus límites se deben revisar antes de aumentar volumen.
