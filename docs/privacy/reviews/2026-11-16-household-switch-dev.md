# Cambio de hogar y origen de las compras en dev

La prueba de cambio de hogar usa cuentas desechables en dev. El servidor muestra los hogares de origen y destino y el rol nuevo solo después de verificar que el correo autenticado coincide con el destinatario de la invitación. La persona confirma el cambio desde su sesión. El servidor registra la cuenta que canjeó la invitación y el hogar anterior para identificar reintentos.

Los borradores y cierres de compra incluyen el identificador del hogar que mostró la app. Las operaciones pendientes de otro hogar o sin origen comprobado quedan visibles para revisión. El servidor rechaza un cierre con un origen distinto del hogar autorizado y verifica la membresía dentro de la escritura. Tras un cambio, las demás escrituras de despensa requieren un contexto de hogar válido.

Un registro interno indica si una cuenta recién creada ya intentó modificar su hogar o sus datos y si necesita aportar contexto explícito en sus escrituras. El cambio de un titular exige un hogar creado automáticamente, de un solo integrante y con evidencia verificable de que sigue sin uso. La transacción conserva las despensas con actividad y descarta el hogar automático solo cuando se comprueba esa condición al confirmar.

Las cuentas que cambian como integrantes conservan los datos en el hogar donde se registraron. El cobro y el historial fiscal se resuelven por hogar mediante los flujos existentes. Las pruebas usan invitaciones y datos ficticios.
