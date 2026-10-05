import { validateSync } from 'class-validator';
import { QuantityUnit } from '../../../domain/enums';
import { CreateInventoryLotDto } from './create-inventory-lot.dto';

const validLot = {
  productTypeId: 'type-1',
  quantity: 1,
  unit: QuantityUnit.PIECE,
  expiresAt: '2026-04-28',
  purchaseDate: '2026-04-24',
};

describe('CreateInventoryLotDto calendar dates', () => {
  it('accepts valid date-only expiration and purchase dates', () => {
    expect(
      validateSync(Object.assign(new CreateInventoryLotDto(), validLot)),
    ).toEqual([]);
  });

  it.each(['expiresAt', 'purchaseDate'] as const)(
    'rejects a timestamp with offset in %s',
    (field) => {
      const dto = Object.assign(new CreateInventoryLotDto(), {
        ...validLot,
        [field]: '2026-04-28T23:30:00-06:00',
      });
      expect(validateSync(dto).map((error) => error.property)).toContain(field);
    },
  );

  it.each(['2026-02-30', '2026-04-31'])(
    'rejects an impossible expiration date %s',
    (expiresAt) => {
      const dto = Object.assign(new CreateInventoryLotDto(), {
        ...validLot,
        expiresAt,
      });
      expect(validateSync(dto).map((error) => error.property)).toContain(
        'expiresAt',
      );
    },
  );
});
