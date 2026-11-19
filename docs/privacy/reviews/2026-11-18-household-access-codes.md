# Códigos de acceso por hogar

El titular confirma el hogar al canjear una credencial aleatoria de 256 bits. La base conserva su resumen SHA-256 y los metadatos de emisión. El texto de la credencial se muestra una vez al operador, en un archivo local privado. Las rutas aceptan el código en el cuerpo de POST, requieren sesión y XSRF y responden sin caché. Los errores y los registros de prueba excluyen el código completo.

El canje consume el código y guarda la concesión de acceso en una transacción que valida la cuenta activa, la membresía y el hogar de origen. La repetición del mismo titular y hogar devuelve el resultado ya guardado. Una concesión temporal vence al terminar sus meses calendario. Las concesiones de códigos distintos se superponen, siguiendo el comportamiento actual de RoadMap2U.

Las concesiones están vinculadas al hogar y se conservan cuando cambia un integrante. La eliminación del titular retira las concesiones y anonimiza sus referencias de canje. El código queda consumido o revocado. La revocación de una concesión conserva los productos, las compras y las listas del hogar.

El canje comprueba la facturación y el bloqueo de Checkout. Las renovaciones que continúan activas impiden consumir el código. Después de confirmar una cancelación, un acceso temporal comienza al terminar el periodo pagado. Un acceso vigente o programado bloquea nuevas compras de suscripción. La gestión del portal y las facturas anteriores permanece disponible.

La emisión y la revocación utilizan la sesión administrativa de AWS y la tabla existente del ambiente. La app carece de rutas públicas de emisión. La cuota de intentos se conserva con un identificador de cuenta resumido y vencimiento breve. El modo de desarrollador quita las cuotas comerciales de integrantes y listas y conserva las protecciones técnicas existentes. Los créditos y los beneficios comerciales adicionales de Pro se definirán en sus propias entregas.
