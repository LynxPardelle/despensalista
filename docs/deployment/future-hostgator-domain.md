# Activación de despensalista.com con correo en HostGator

El 13 de noviembre de 2026 se creó la zona pública de Route 53 y se copiaron los 25 registros de HostGator. Se ajustó la zona para que los servicios de correo dejen de depender del dominio raíz cuando la web pase a AWS. La delegación pública a Route 53 se verificó en el registro `.com`, Google y Cloudflare. [Zona pública de Route 53](https://console.aws.amazon.com/route53/v2/hostedzones#ListRecordSets/Z05281283BANS93NW89NL)

## Validar el certificado

ACM emitió el certificado público no exportable en `us-east-1`, ID `73abd2e5-39bc-4113-b44e-5c29f3530889`. CloudFront ya usa ese certificado para el dominio raíz, `www` y el nombre anterior. Conserva los registros CNAME de validación en Route 53 para la renovación. [Validación DNS de ACM](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)

| Tipo | Nombre completo | Destino |
| --- | --- | --- |
| CNAME | `_d2d6384ce26200fd33c8f73e4cb6637c.despensalista.com.` | `_58623838f855a7ed46e599acec3833f8.wzccmgtwzk.acm-validations.aws.` |
| CNAME | `_5a323df8369f485423bf77847e5140ef.www.despensalista.com.` | `_f2003bcf9e2fd8d6316dbcac72d41317.wzccmgtwzk.acm-validations.aws.` |

## Cambiar la delegación

Sustituye los nameservers en el registro del dominio en HostGator. La zona de AWS conserva el destino web actual mientras se emite el certificado. Mantén la zona de HostGator durante la propagación. Confirma que el dominio sigue sin registro DS en el padre antes del cambio. [Migración DNS con Route 53](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/migrate-dns-domain-in-use.html)

- `ns-342.awsdns-42.com`
- `ns-516.awsdns-00.net`
- `ns-1718.awsdns-22.co.uk`
- `ns-1415.awsdns-48.org`

Verifica delegación, MX, resolución de `mail`, SPF y DKIM. Haz una prueba real de recepción y envío desde un buzón de HostGator. El MX debe resolver a `mail.despensalista.com` y esa entrada debe conservar `162.241.62.201`. Route 53 cobra USD 0.50 mensuales por la zona en el tramo actual, más consultas aplicables. [Precios de Route 53](https://aws.amazon.com/route53/pricing/)

## Activar el sitio en AWS

1. La distribución `EWXF7S0KL4WVN` ya admite los tres nombres. El cliente web de Cognito conserva las URL de entrada y salida del dominio anterior e incluye las del nuevo. El despliegue de producción usa `ENABLE_PUBLIC_PRODUCTION_DOMAIN=true` y `PUBLIC_PRODUCTION_CERTIFICATE_ARN` con el certificado emitido. [Dominios alternativos de CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html) · [URLs del cliente Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-client-apps.html)
2. Promover un release que seleccione el callback y la URL de salida según el host verificado por CloudFront. Antes de cambiar los registros web, probar HTTPS y el inicio de sesión en ambos dominios con `curl --connect-to`, y confirmar que `www` redirige al raíz y conserva la ruta y los parámetros.
3. Comprobar los registros de correo ya preparados en Route 53. `webmail`, `cpanel` y `ftp` apuntan a `mail.despensalista.com`. Los SRV usan `cpcalendars` y `cpcontacts` con los puertos 2079 y 2080, y el SPF usa `v=spf1 mx include:websitewelcome.com ~all`. Durante la revisión, los servicios TLS consultados presentaron un certificado para `*.hostgator.mx`. Para clientes de correo, usar el nombre seguro que indica cPanel y verificar envío y recepción. [Configuración TLS de HostGator](https://soporte.hostgator.mx/hc/es-419/articles/28445238003091-POP3-o-IMAP-con-SSL)
4. Publicar A/AAAA Alias de raíz y `www` a CloudFront una vez desplegado el certificado y asociadas las dos variantes. Convertir el CNAME existente de `www` dentro del mismo cambio de DNS. Validar HTTPS y `/api/healthz`, inicio y cierre de sesión, restablecimiento de contraseña, invitaciones y la PWA. El cambio de origen requiere iniciar sesión de nuevo. Sincronizar las operaciones offline antes de mover a los usuarios.
5. Para revertir la web, restaurar el A raíz de HostGator y el CNAME de `www`, y volver a la configuración de callback y origen anterior. Si el problema es la delegación, restaurar los dos nameservers de HostGator en el registrador. Confirmar MX y los resultados de envío y recepción después de la reversión.
