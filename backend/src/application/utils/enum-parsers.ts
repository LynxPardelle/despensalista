import { BadRequestException } from '@nestjs/common';
import {
  DepletionPeriod,
  DepletionRulePrimitives,
} from '../../domain/entities/product-type.entity';
import { ProductCategory, QuantityUnit } from '../../domain/enums';
import {
  addCivilDays,
  addCivilMonths,
  isSupportedCivilDateLabel,
} from '../../domain/utils/civil-date';

export function parseQuantityUnit(value: string): QuantityUnit {
  const normalizedValue = value as QuantityUnit;
  const unit = Object.values(QuantityUnit).find(
    (candidate) => candidate === normalizedValue,
  );

  if (!unit) {
    throw new BadRequestException(`Unsupported quantity unit: ${value}`);
  }

  return unit;
}

export function parseProductCategory(value: string): ProductCategory {
  const normalizedValue = value as ProductCategory;
  const category = Object.values(ProductCategory).find(
    (candidate) => candidate === normalizedValue,
  );

  if (!category) {
    throw new BadRequestException(`Unsupported product category: ${value}`);
  }

  return category;
}

export interface DepletionRuleInput {
  enabled: boolean;
  consumeAmount: number;
  unit: string;
  everyAmount: number;
  everyPeriod: string;
  anchorDate: Date | string;
}

export function parseDefaultDepletionRule(
  value: DepletionRuleInput | undefined,
  defaultUnit: QuantityUnit,
): DepletionRulePrimitives | undefined {
  if (!value) {
    return undefined;
  }

  const unit = parseQuantityUnit(value.unit);

  if (unit !== defaultUnit) {
    throw new BadRequestException(
      'Depletion rule unit must match product type default unit',
    );
  }

  if (value.consumeAmount <= 0) {
    throw new BadRequestException(
      'Depletion consume amount must be greater than zero',
    );
  }

  if (!Number.isSafeInteger(value.everyAmount) || value.everyAmount <= 0) {
    throw new BadRequestException(
      'Depletion interval amount must be a positive integer',
    );
  }

  const everyPeriod = parseDepletionPeriod(value.everyPeriod);
  const anchorDate = new Date(value.anchorDate);
  if (!isSupportedCivilDateLabel(anchorDate)) {
    throw new BadRequestException('Depletion anchor date is not supported');
  }
  const firstOccurrence =
    everyPeriod === 'month'
      ? addCivilMonths(anchorDate, value.everyAmount)
      : addCivilDays(
          anchorDate,
          value.everyAmount * (everyPeriod === 'week' ? 7 : 1),
        );
  if (!isSupportedCivilDateLabel(firstOccurrence)) {
    throw new BadRequestException(
      'Depletion interval exceeds supported calendar range',
    );
  }

  return {
    enabled: value.enabled,
    consumeAmount: value.consumeAmount,
    unit,
    everyAmount: value.everyAmount,
    everyPeriod,
    anchorDate,
  };
}

function parseDepletionPeriod(value: string): DepletionPeriod {
  if (value === 'day' || value === 'week' || value === 'month') {
    return value;
  }

  throw new BadRequestException(
    `Unsupported depletion interval period: ${value}`,
  );
}
