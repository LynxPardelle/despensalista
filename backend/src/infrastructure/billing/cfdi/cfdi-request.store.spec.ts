import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ConfigService } from '@nestjs/config';
import type { DynamoDbDocumentClientService } from '../../database/dynamodb/dynamodb-document-client.service';
import { readCfdiRequest } from './cfdi-request';
import {
  CfdiRequestStore,
  cfdiReceipt,
  type StoredCfdiRequest,
} from './cfdi-request.store';

const fiscal = {
  rfc: 'XAXX010101000',
  legalName: 'Persona de prueba',
  postalCode: '01234',
  taxRegime: '616',
  cfdiUse: 'S01',
};
const input = {
  table: 'billing-test',
  userId: 'user',
  householdId: 'home',
  customerId: 'cus_Test',
  invoiceId: 'in_Test',
  data: fiscal,
};

describe('datos fiscales de la solicitud', () => {
  it('acepta omitir el correo y conserva los ceros del código postal', () => {
    expect(
      readCfdiRequest({ ...fiscal, rfc: fiscal.rfc.toLowerCase() }),
    ).toEqual(fiscal);
  });

  it('rechaza campos adicionales y saltos de línea en el nombre', () => {
    expect(() => readCfdiRequest({ ...fiscal, attachment: 'file' })).toThrow();
    expect(() =>
      readCfdiRequest({ ...fiscal, legalName: 'Nombre\nCorreo: otro' }),
    ).toThrow();
  });
});

describe('reserva transaccional de una solicitud por factura', () => {
  const send = jest.fn<Promise<object>, [TransactWriteCommand]>();
  const store = new CfdiRequestStore(
    new ConfigService({ DYNAMODB_USERS_TABLE: 'users-test' }),
    { send } as unknown as DynamoDbDocumentClientService,
  );

  beforeEach(() => send.mockReset().mockResolvedValue({}));

  it('reserva un folio separado del ítem fiscal y quita los datos al obtener confirmación de SES', async () => {
    const reserved = (await store.reserve(input))!;
    const [account, billing, receipt, details] =
      send.mock.calls[0][0].input.TransactItems!;
    expect(account.ConditionCheck).toMatchObject({
      TableName: 'users-test',
      Key: { pk: 'USER#user' },
      ConditionExpression: expect.stringContaining('deletionFenceExpiresAt'),
    });
    expect(billing.ConditionCheck).toMatchObject({
      Key: { pk: 'household:home' },
    });
    expect(receipt.Put).toMatchObject({
      Item: { pk: 'cfdi-request:in_Test', id: reserved.id, status: 'sending' },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(receipt.Put?.Item).not.toHaveProperty('rfc');
    expect(receipt.Put?.Item).not.toHaveProperty('email');
    expect(details.Put?.Item).toMatchObject({
      pk: 'cfdi-fiscal-data:in_Test',
      requestId: reserved.id,
      rfc: fiscal.rfc,
    });
    expect(details.Put?.Item?.expiresAt).toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    );
    expect(cfdiReceipt(reserved)).toEqual({
      id: reserved.id,
      status: 'pending',
    });

    await expect(
      store.finish(input.table, input.invoiceId, reserved, {
        status: 'sent',
        messageId: 'confirmation',
      }),
    ).resolves.toMatchObject({ id: reserved.id, status: 'sent' });
    const [sent, deleteFiscal] = send.mock.calls[1][0].input.TransactItems!;
    expect(sent.Put?.Item).not.toHaveProperty('rfc');
    expect(sent.Put?.ExpressionAttributeValues?.[':attempt']).toBe(
      reserved.attempt,
    );
    expect(deleteFiscal.Delete?.Key).toEqual({
      pk: 'cfdi-fiscal-data:in_Test',
    });
  });

  it('reintenta únicamente desde un rechazo definitivo y conserva el folio', async () => {
    const previous: StoredCfdiRequest = {
      id: 'folio',
      householdId: 'home',
      status: 'pending',
      attempt: 'rejected',
      attemptedAt: Date.now() - 70_000,
    };
    expect(cfdiReceipt(previous)).toEqual({
      id: 'folio',
      status: 'pending',
      retryable: true,
    });
    expect(cfdiReceipt({ ...previous, status: 'sending' })).toEqual({
      id: 'folio',
      status: 'delivery_unknown',
    });
    await expect(store.reserve({ ...input, previous })).resolves.toMatchObject({
      id: 'folio',
    });
    expect(
      send.mock.calls[0][0].input.TransactItems?.[2].Put
        ?.ExpressionAttributeValues,
    ).toMatchObject({
      ':retryable': 'pending',
      ':previous': 'rejected',
    });
  });

  it('permite que otra petición consulte la reserva existente sin enviar una segunda vez', async () => {
    send.mockRejectedValueOnce(
      new TransactionCanceledException({
        message: 'Conditional transaction cancelled',
        $metadata: {},
        CancellationReasons: [
          { Code: 'None' },
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
        ],
      }),
    );
    await expect(store.reserve(input)).resolves.toBeUndefined();
  });
});
