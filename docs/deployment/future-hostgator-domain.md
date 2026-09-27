# Dominio futuro registrado en HostGator

Preparación: 2026-09-25. No se ha comprado ningún dominio, contratado hosting ni
modificado DNS externo. La aplicación sigue en `despensalista.lynxpardelle.com`.

## Datos pendientes

- Dominio exacto y nombre canónico elegido: raíz o `app.<dominio>`.
- Acceso del propietario para administrar DNS o delegar nameservers en HostGator.
- Confirmar quién administra el correo actual y conservar sus registros MX/TXT.
- Remitente deseado y dirección operativa para respuestas/soporte. SES envía correo;
  no crea por sí solo un buzón donde recibirlo.

## Ruta recomendada para la infraestructura actual

1. Mantener HostGator como registrador; no hace falta trasladar allí la aplicación.
   Decidir si se delegará la zona completa o solo el subdominio de la aplicación a
   Route53. Antes de cambiar nameservers, inventariar y copiar todos los registros
   existentes, especialmente MX, SPF, DKIM y verificaciones; comprobar DNSSEC si
   estaba habilitado. No reutilizar la zona `lynxpardelle.com` para otro dominio.
2. Revisar el costo antes de crear la nueva zona: Route53 publica USD 0.50/mes para
   cada una de las primeras 25 zonas, más consultas aplicables. Las consultas A/AAAA
   Alias hacia CloudFront no se cobran. Registrar el dominio en HostGator tiene un
   precio y renovación independientes que deberán confirmarse para el nombre exacto.
   [Precios Route53](https://aws.amazon.com/route53/pricing/).
3. Emitir un certificado público ACM **no exportable** en `us-east-1` para todos los
   nombres que atenderá CloudFront. Validarlo mediante DNS y conservar esos CNAME
   para renovaciones. Este tipo de certificado no tiene costo adicional; no elegir
   certificados exportables ni Private CA.
   [Región de ACM para CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html),
   [precios ACM](https://aws.amazon.com/certificate-manager/pricing/).
4. Adaptar el CDK para conservar temporalmente el dominio anterior y agregar el
   nuevo al certificado y a los aliases de la distribución. Actualmente hay un solo
   `appDomainName`: cambiarlo directamente no configura esa convivencia. Actualizar
   `hostedZoneId`, `hostedZoneName`, `appDomainName`, permisos IAM de DNS limitados a
   esos nombres y el inventario de entrega. Crear Alias A/AAAA hacia CloudFront
   cuando distribución y certificado estén listos.
   [Dominios alternativos de CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html).
5. Conservar el user pool y client de Cognito, MFA e identidades existentes. Añadir
   el nuevo callback `https://<dominio>/api/auth/cognito/callback` y logout permitido;
   mantener los anteriores durante la transición. Actualizar URL pública, CORS,
   redirects del backend, variables de GitHub y smoke. El prefijo de login Cognito
   puede quedarse igual; no hace falta un dominio de autenticación nuevo. Si se
   cambia también ese dominio, revisar los callbacks de Google y su certificado.
   [URLs del cliente Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-client-apps.html).
6. Para cambiar el remitente, verificar la nueva identidad SES en la región de
   envío, publicar sus CNAME Easy DKIM de 2048 bits y comprobar estado verificado.
   Cambiar `sesIdentityDomain` y las restricciones IAM correspondientes; no borrar
   primero la identidad actual. Verificar acceso de producción SES: autenticar un
   dominio no elimina el sandbox, que sigue limitando destinatarios. Conservar
   correo administrado por Cognito hasta obtener aprobación y probar entregabilidad.
   [Identidades y DKIM](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html),
   [salida del sandbox](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).
7. Promover la misma release dev → tst → prod. Verificar HTTPS, `/api/healthz`, login
   con correo/TOTP y Google, logout, invitaciones, recuperación de contraseña,
   compra/consumo y PWA en el nuevo nombre. Un cambio de origen no traslada cookies
   ni almacenamiento local: avisar que habrá que iniciar sesión de nuevo y resolver
   compras offline pendientes en el dominio anterior antes del corte.
8. Mantener DNS, certificado y callbacks antiguos mientras se verifica el nuevo
   origen. Retirarlos solo tras acordar la transición. Si falla la verificación,
   restaurar URL pública/DNS al origen anterior y el artefacto/alias publicado;
   no eliminar pools ni datos como parte del rollback de dominio.

Alternativa: mantener DNS autoritativo en HostGator y publicar allí CNAME de
validación y un CNAME de subdominio a CloudFront. Evita otra zona Route53, pero
requiere adaptar CDK, que actualmente valida certificados y crea DNS en Route53.
No asumir que el dominio raíz admite CNAME ni contratar IPs estáticas para
resolverlo: elegir un subdominio o verificar soporte Alias/ANAME con el proveedor.
