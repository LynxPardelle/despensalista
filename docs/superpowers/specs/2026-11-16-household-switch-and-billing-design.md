# Cambio de hogar y alcance de las suscripciones

La primera entrega permitirá cambiar de hogar mediante una invitación y una confirmación explícita. Será una función de Gratis y de los planes de pago. La cuenta tendrá un hogar activo tras el cambio. Plus Hogar cubrirá al hogar que contrató la suscripción, con sus beneficios y límites compartidos entre sus integrantes.

## Comportamiento del cambio

| Situación de la cuenta | Acción de DespensaLista |
| --- | --- |
| Todavía no tiene hogar | Acepta la invitación luego de validar correo, vigencia y cupo. El enlace lleva primero a la invitación, antes de crear una despensa personal. |
| Es editora o lectora de otro hogar | Muestra el hogar de origen, el de destino y el rol nuevo. Al confirmar, reemplaza la membresía. Las compras, el inventario, las listas y los cobros se conservan en sus hogares respectivos. |
| Es titular de un hogar personal creado automáticamente y sin uso verificable | Ofrece cerrar ese hogar e incorporarse al nuevo con una confirmación que identifique ambos hogares. Puede aplicarse cuando el servidor prueba que el hogar tiene solo al titular y carece de datos, actividad de colaboración e historial de cobro. |
| Es titular de un hogar con actividad, otros integrantes, facturación o estado indeterminado | Conserva el hogar y muestra el motivo. Mantener acceso a ambos hogares requiere la opción de múltiples membresías. Transferir un hogar existente a otro titular necesita su propio flujo. |

La aceptación del cambio valida otra vez la membresía de origen y el destinatario, la vigencia, el estado y el cupo de la invitación de destino. El servidor consume la invitación y guarda la nueva membresía en la misma transacción. Si se pierde la respuesta, la misma operación devuelve el resultado original. Al cerrar un hogar automático, su condición de hogar sin uso se verifica bajo las mismas protecciones contra escrituras y nuevas sesiones de Checkout. Un contador de productos activos en cero no demuestra esa condición porque puede haber compras, listas, datos archivados o historial de cobro.

## Orden de implementación

1. Guardar el hogar de origen junto con cada borrador y cada compra pendiente, y exigir que la API valide esa relación al confirmar una escritura. Una pestaña anterior o una PWA que se reconecta debe conservar el borrador con su origen y pedir revisión si allí se perdió el acceso. Si una operación antigua carece de ese dato, la app la deja pendiente de revisión.
2. Habilitar el cambio de editor o lector a otro hogar mediante una invitación y confirmación. Proteger la transacción ante la pérdida de respuesta, dos cambios simultáneos, el último cupo y la baja concurrente de la cuenta.
3. Habilitar el cierre de un hogar personal automático cuando su estado sin uso se pueda comprobar del lado del servidor. Registrar esa condición desde el alta de hogares nuevos y tratar los hogares anteriores como indeterminados mientras no haya evidencia suficiente.

Las pruebas de dev y tst deben cubrir la compra pendiente de otro hogar, la aceptación válida, el destinatario incorrecto, las invitaciones vencidas o revocadas, el último cupo disputado, dos cambios simultáneos y una aceptación reintentada tras perder su respuesta. Las pruebas de titulares deben cubrir un hogar automático sin uso, otro con compras archivadas, otro con más integrantes y otro con Stripe o CFDI. Los repositorios de DynamoDB y MongoDB deben sostener la misma regla de membresía.

## Varios hogares y facturación

El modelo actual resuelve una sola membresía por cuenta. La despensa usa el identificador del titular como clave de datos, mientras el cobro, CFDI y planes usan el identificador del hogar. Antes de que una cuenta administre varios hogares, los datos deben tener una clave estable por hogar. El selector debe determinar el rol y el alcance de cada lectura, escritura, operación pendiente y eliminación de datos. Una transferencia de titularidad también debe distinguir la responsabilidad de la despensa del consentimiento del nuevo pagador y el acceso fiscal a pagos anteriores.

Plus Hogar y un eventual Pro se ofrecen primero por hogar. Cambiar de hogar o aceptar una invitación para colaborar no se cobra como beneficio personal. Si durante el piloto aparece una necesidad frecuente de administrar dos despensas propias, se puede valorar un plan Multihogar para una misma persona pagadora. El paquete asignaría beneficios a un número explícito de hogares. Cada hogar conservaría sus integrantes, límites, permisos e historial propio.

## Código que sustenta la decisión

- [Resolución y aceptación de hogar](../../../backend/src/application/use-cases/household.use-cases.ts)
- [Transacciones y claves de membresía](../../../backend/src/infrastructure/database/dynamodb/dynamodb-household.repository.ts)
- [Borradores y compras pendientes](../../../frontend/src/app/features/pantry/pantry-page.component.ts)
- [Cobro de Plus Hogar](../../../backend/src/infrastructure/billing/stripe-billing.service.ts) y [solicitudes de CFDI](../../../backend/src/infrastructure/billing/cfdi/cfdi.service.ts)
