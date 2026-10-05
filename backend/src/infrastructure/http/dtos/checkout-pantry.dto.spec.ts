import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { QuantityUnit } from '../../../domain/enums';
import { CheckoutPantryDto } from './checkout-pantry.dto';

const validItem = {
  productTypeId: 'type-1',
  quantity: 1,
  unit: QuantityUnit.PIECE,
  expiresAt: '2026-04-28',
};

describe('CheckoutPantryDto calendar dates', () => {
  it('accepts a valid date-only expiration in a nested item', () => {
    const dto = plainToInstance(CheckoutPantryDto, { items: [validItem] });
    expect(validateSync(dto)).toEqual([]);
  });

  it.each(['2026-04-28T23:30:00-06:00', '2026-02-30', '2026-04-31'])(
    'rejects a non-calendar expiration date %s in a nested item',
    (expiresAt) => {
      const dto = plainToInstance(CheckoutPantryDto, {
        items: [{ ...validItem, expiresAt }],
      });
      const itemError = validateSync(dto)[0]?.children?.[0];
      expect(itemError?.children?.map((error) => error.property)).toContain(
        'expiresAt',
      );
    },
  );
});
