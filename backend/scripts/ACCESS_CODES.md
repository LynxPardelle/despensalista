# Códigos de acceso de DespensaLista

La herramienta emite códigos de un solo uso para un hogar. El titular los canjea en Perfil. Los códigos temporales conceden meses calendario y los vitalicios conservan el acceso sin vencimiento. Los códigos de desarrollador son vitalicios, se vinculan a un correo y habilitan las capacidades internas de desarrollador. Las cuotas técnicas por solicitud siguen protegiendo las transacciones.

Los planes admitidos son `plus` y `pro`. Pro conserva las prestaciones actuales de Plus y reserva su identidad para las capacidades futuras del catálogo. La emisión de un código concede acceso por canje. La venta pública de una opción vitalicia requiere su oferta comercial y facturación correspondientes.

## Preparación

Desde `backend`, ejecutar `npm run build`. La herramienta usa la sesión local de AWS, verifica la cuenta `765932874577`, la región `us-east-1` y la tabla existente `despensalista-<stage>-users`. La identidad AWS necesita permisos de lectura y escritura de los registros de acceso en esa tabla. La emisión permanece dentro de la autorización AWS del operador.

La implementación reutiliza el patrón de RoadMap2U de credencial aleatoria, canje transaccional, acceso independiente de Stripe y una sola presentación del código. DespensaLista almacena SHA-256 de una credencial aleatoria de 32 bytes. Su validación no necesita un parámetro secreto ni otro servicio AWS. Los identificadores y los metadatos operativos permiten consultar el estado sin recuperar la credencial.

## Emisión

La herramienta muestra primero una simulación local. El siguiente ejemplo prepara tres códigos Plus de dos meses.

```powershell
node scripts/access-codes.cjs issue --stage dev --plan plus --months 2 --count 3 --reason beta-cohort
```

Para emitirlos, se añade `--apply` y un archivo local absoluto. El archivo debe ser nuevo. En Windows se retira la herencia de permisos y se concede acceso únicamente al usuario local. El código completo queda en ese archivo privado y la terminal imprime el ID del lote, el número de códigos y su ubicación.

```powershell
node scripts/access-codes.cjs issue --stage dev --plan plus --months 2 --count 3 --reason beta-cohort --output C:\Users\Lynx\Documents\despensalista-beta-codes.json --apply
```

El plazo de canje predeterminado es de 30 días. Puede ajustarse con `--redeem-until 2027-01-01T00:00:00.000Z`. `--months` permite de 1 a 120 meses. `--lifetime` reemplaza la duración. El lote admite hasta 100 códigos, cada uno con su propia credencial. Para entregar un código a un correo concreto, agregar `--email usuario@example.com`.

Los códigos de desarrollador requieren correo y permanencia.

```powershell
node scripts/access-codes.cjs issue --stage dev --plan pro --mode developer --lifetime --email desarrollador@example.com --reason internal-development --output C:\Users\Lynx\Documents\despensalista-developer-code.json --apply
```

El archivo privado se guarda antes de crear los registros. Si el proceso se interrumpe, conservarlo y continuar la misma emisión con `resume`. La herramienta verifica los registros ya emitidos y continúa los faltantes.

```powershell
node scripts/access-codes.cjs resume --stage dev --output C:\Users\Lynx\Documents\despensalista-beta-codes.json --apply
```

Entregar cada código individualmente. Conservar el archivo solo durante la entrega, con protección local y fuera de repositorios, tickets, capturas y registros compartidos.

## Consulta y revocación

`list` es de solo lectura y devuelve los metadatos paginados. No incluye credenciales ni digests. Para la página siguiente, pasar el valor de `cursor` a `--cursor`.

```powershell
node scripts/access-codes.cjs list --stage dev --limit 25
node scripts/access-codes.cjs revoke --stage dev --id UUID-DE-EMISION --reason issued-in-error
node scripts/access-codes.cjs revoke --stage dev --id UUID-DE-EMISION --reason issued-in-error --apply
```

Revocar un código pendiente impide su canje. Revocar un código canjeado retira únicamente la concesión asociada. La eliminación del hogar retira sus concesiones y anonimiza las referencias de los códigos consumidos, conservando su condición de usado.

## Canje y cobros

Un código solo puede canjearse una vez. La repetición por el mismo titular y el mismo hogar recupera el resultado original. El canje requiere la membresía vigente, una cuenta activa y un hogar abierto. El servidor limita los intentos a diez por hora por cuenta y elimina sus contadores mediante TTL.

Los beneficios de códigos diferentes se solapan. Sus fechas parten del canje y no acumulan automáticamente meses entre sí. Si hay una suscripción con la renovación ya cancelada, el acceso temporal comienza al acabar su periodo pagado. Los códigos vitalicios comienzan al canjear. Una suscripción que todavía renueva debe cancelarse desde el portal antes de canjear. El canje conserva los cobros e invoices existentes y no ejecuta operaciones en Stripe.

Repetir los comandos con `--stage tst` o `--stage prod` permite operar el ambiente seleccionado. Las sesiones AWS y los archivos de códigos deben corresponder al mismo ambiente. Los códigos de prueba de dev y tst no sirven en producción.
