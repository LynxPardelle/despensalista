import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ProductCategory, QuantityUnit } from '../../../domain/enums';
import {
  CreateProductTypeDto,
  ProductTypeDepletionRuleDto,
  UpdateProductTypeDepletionRuleDto,
} from './create-product-type.dto';

const validRule = {
  enabled: true,
  consumeAmount: 1,
  unit: QuantityUnit.LITER,
  everyAmount: 1,
  everyPeriod: 'day',
  anchorDate: '2026-04-28',
};

describe('ProductTypeDepletionRuleDto', () => {
  it('rejects a fractional recurrence interval at the HTTP boundary', () => {
    const dto = Object.assign(new ProductTypeDepletionRuleDto(), {
      ...validRule,
      everyAmount: 1.5,
    });

    expect(validateSync(dto).map((error) => error.property)).toContain(
      'everyAmount',
    );
  });

  it.each(['2026-04-28T23:30:00-06:00', '2026-02-30', '2026-04-31'])(
    'rejects a non-calendar anchor date %s',
    (anchorDate) => {
      const dto = Object.assign(new ProductTypeDepletionRuleDto(), {
        ...validRule,
        anchorDate,
      });

      expect(validateSync(dto).map((error) => error.property)).toContain(
        'anchorDate',
      );
    },
  );

  it('accepts a valid date-only anchor and validates nested create/update rules', () => {
    const rule = Object.assign(new ProductTypeDepletionRuleDto(), validRule);
    const create = plainToInstance(CreateProductTypeDto, {
      baseName: 'Jabon',
      category: ProductCategory.CLEANING,
      defaultUnit: QuantityUnit.LITER,
      defaultDepletionRule: validRule,
    });
    const update = plainToInstance(UpdateProductTypeDepletionRuleDto, {
      defaultDepletionRule: validRule,
    });

    expect(validateSync(rule)).toEqual([]);
    expect(validateSync(create)).toEqual([]);
    expect(validateSync(update)).toEqual([]);
  });

  it('rejects a timestamp anchor in the nested update rule', () => {
    const update = plainToInstance(UpdateProductTypeDepletionRuleDto, {
      defaultDepletionRule: {
        ...validRule,
        anchorDate: '2026-04-28T23:30:00-06:00',
      },
    });

    expect(
      validateSync(update)[0]?.children?.map((error) => error.property),
    ).toContain('anchorDate');
  });
});
