# Inicio de sesión en despensalista.com

El dominio público usa la distribución y el cliente de Cognito existentes. El
inicio de sesión conserva la comprobación de estado, nonce y PKCE. El backend
elige el callback y la URL de salida del nuevo dominio a partir del host que
establece CloudFront. CloudFront reemplaza el encabezado de entrada y el
backend exige la configuración de verificación del origen.

Las cookies siguen vinculadas al host que las emitió. Quien abra un dominio
nuevo inicia una sesión en ese dominio. Los datos de la cuenta siguen en el
mismo pool y las mismas tablas. La aplicación comparte con Cognito los datos
habituales de inicio de sesión y las URL autorizadas. La migración del dominio
no habilita la facturación ni cambia el servicio que recibe correo.

Los registros existentes de MX, DKIM y los servicios de correo dirigen a
HostGator. Mantener ambos orígenes de la aplicación durante el cambio permite
restaurar el acceso por el dominio anterior. En la reversión, verificar que el
DNS público y el código de Lambda soporten los nombres que CloudFront atiende.
