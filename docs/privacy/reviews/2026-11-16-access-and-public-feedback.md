# Acceso y reportes sin sesión

El enlace para reportar abre el formulario aunque la sesión haya caducado. El reporte contiene la categoría, la descripción escrita por el visitante, la fecha y el folio. Puede incluir la sección y un código de error de una lista fija. La URL completa, los parámetros de inicio de sesión, las cookies, las credenciales y el navegador quedan fuera del contexto del reporte.

El envío sin sesión usa una ruta propia y omite las cookies. El servidor exige JSON y un origen permitido. La operación que guarda el reporte aplica un límite diario global. Los reportes sin sesión vencen a los 30 días y los contadores vencen a los dos días. El equipo autorizado consulta los registros en la bandeja existente. Los reportes enviados con sesión conservan su límite por cuenta, su vencimiento de 90 días y su eliminación al borrar la cuenta.

El formulario pide que la persona evite contraseñas, códigos de acceso, datos de pago e información personal en la descripción. Las alertas de cuota y del callback usan categorías de diagnóstico fijas. El flujo de Cognito conserva las verificaciones de estado, PKCE y nonce.
