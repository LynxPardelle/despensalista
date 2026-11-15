# Bandeja de reportes de DespensaLista

En Perfil, abre **Ayuda y comentarios → Reportar un error, queja o sugerencia**. El formulario exige una sesión y devuelve un folio cuando guarda el reporte. Una cuenta puede enviar hasta cinco reportes por día UTC. Si reintenta el mismo envío desde el formulario, conserva el folio. [Perfil de dev](https://dev.despensalista.lynxpardelle.com/profile) · [Perfil de tst](https://test.despensalista.lynxpardelle.com/profile) · [Perfil de producción](https://despensalista.com/profile)

## Consultar reportes

Usa una sesión AWS autorizada con `dynamodb:Query` sobre el índice `FeedbackInboxByMonth` de la tabla del entorno en `us-east-1`. Selecciona `dev`, `tst` o `prod` en `$feedbackStage`. La consulta devuelve primero los reportes más recientes del mes UTC y omite los vencidos. Para un mes anterior, sustituye `$feedbackMonth` por el mes en formato `yyyy-MM`. Para continuar una consulta paginada, agrega `--starting-token` con el `NextToken` que entregue AWS.

```powershell
$feedbackStage = 'dev'
if ($feedbackStage -notin @('dev', 'tst', 'prod')) { throw 'El entorno de reportes no es válido' }
$feedbackMonth = [DateTime]::UtcNow.ToString('yyyy-MM')
$feedbackQuery = @{
  TableName = "despensalista-$feedbackStage-feedback"
  IndexName = 'FeedbackInboxByMonth'
  KeyConditionExpression = '#month = :month'
  FilterExpression = '#expiry > :now'
  ProjectionExpression = '#id, #category, #message, #created'
  ExpressionAttributeNames = @{
    '#month' = 'inboxMonth'
    '#expiry' = 'expiresAt'
    '#id' = 'id'
    '#category' = 'category'
    '#message' = 'message'
    '#created' = 'createdAt'
  }
  ExpressionAttributeValues = @{
    ':month' = @{ S = "INBOX#$feedbackMonth" }
    ':now' = @{ N = [string][DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
  }
  ScanIndexForward = $false
}
$feedbackQueryFile = [IO.Path]::GetTempFileName()
try {
  [IO.File]::WriteAllText($feedbackQueryFile, ($feedbackQuery | ConvertTo-Json -Depth 6))
  aws dynamodb query --region us-east-1 --cli-input-json "file://$feedbackQueryFile" `
    --max-items 25 --output json --no-cli-pager
} finally {
  Remove-Item -LiteralPath $feedbackQueryFile
}
```

El índice puede tardar brevemente en reflejar un reporte nuevo o eliminado. Para identificar un reporte, usa el folio devuelto por el formulario. La bandeja muestra el folio, la categoría, la fecha y el texto. Comparte solo el folio y un resumen que omita información personal si necesitas registrar el trabajo en otra herramienta.

## Conservación

El formulario avisa que se evite incluir datos personales, contraseñas o información de pago. El registro usa un identificador de cuenta seudonimizado para controlar el límite y eliminar los reportes cuando se borra la cuenta. El sistema almacena la categoría, el mensaje, el folio y la fecha. Los reportes vencen a los 90 días y los contadores a los dos días. DynamoDB retira los registros vencidos de forma asíncrona.

Cada entorno dispone de una tabla DynamoDB bajo demanda. La tabla de producción tiene protección contra borrado y CloudFormation conserva sus datos al retirar o reemplazar el recurso. Si una primera creación falla después de aprovisionar la tabla, revisa a qué stack pertenece antes de reintentar el despliegue. El formulario entrega un folio y no envía correo.
