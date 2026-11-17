# Aceptación de enlaces de invitación al hogar

El formulario acepta el código o el enlace de invitación de Perfil. Si la persona pega un enlace del mismo entorno, el navegador extrae el código y lo envía a la API autenticada. La URL pegada se interpreta como texto. El formulario rechaza destinos de otro entorno y parámetros de invitación repetidos.

La API comprueba que el código corresponda a una invitación vigente, que el correo coincida con la cuenta autenticada y que el hogar disponga de cupo. Si la cuenta ya pertenece a otro hogar, la respuesta incluye solo el rol de esa misma cuenta para que Perfil pueda explicar la situación. La API rechaza ese intento antes de guardar la membresía o aceptar la invitación.

El servidor conserva el mecanismo existente de almacenar el hash y limitar la vigencia de la invitación. Las comprobaciones automatizadas usan enlaces, códigos y cuentas ficticias.
