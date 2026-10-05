import {
  DepletionPeriod,
  DepletionRulePrimitives,
} from '../../domain/entities/product-type.entity';
import {
  addCivilDays,
  addCivilMonths,
  isSupportedCivilDateLabel,
  mexicoCityDateLabel,
  utcDateLabel,
} from '../../domain/utils/civil-date';

export interface DepletionForecast {
  depletionRule: DepletionRulePrimitives;
  recordedAvailableQuantity: number;
  completedIntervals: number;
  estimatedConsumedQuantity: number;
  estimatedCurrentQuantity: number;
  estimatedDepletionAt: Date;
}

export interface DepletionForecastInput {
  recordedAvailableQuantity: number;
  startDate?: Date;
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;

export function calculateDepletionForecast(
  depletionRule: DepletionRulePrimitives | undefined,
  recordedAvailableQuantity: number,
  referenceDate: Date = new Date(),
): DepletionForecast | undefined {
  if (!depletionRule?.enabled) {
    return undefined;
  }

  if (!isForecastableRule(depletionRule)) {
    return undefined;
  }

  const completedIntervals = countCompletedIntervals(
    depletionRule.anchorDate,
    referenceDate,
    depletionRule.everyAmount,
    depletionRule.everyPeriod,
  );
  const estimatedConsumedQuantity = roundQuantity(
    completedIntervals * depletionRule.consumeAmount,
  );
  const estimatedCurrentQuantity = Math.max(
    roundQuantity(recordedAvailableQuantity - estimatedConsumedQuantity),
    0,
  );
  if (
    !Number.isFinite(estimatedConsumedQuantity) ||
    !Number.isFinite(estimatedCurrentQuantity)
  ) {
    return undefined;
  }
  const estimatedDepletionAt =
    estimatedCurrentQuantity <= 0
      ? mexicoCityDateLabel(referenceDate)
      : addIntervals(
          depletionRule.anchorDate,
          depletionRule.everyAmount *
            (completedIntervals +
              Math.ceil(
                estimatedCurrentQuantity / depletionRule.consumeAmount,
              )),
          depletionRule.everyPeriod,
        );
  if (!isSupportedCivilDateLabel(estimatedDepletionAt)) {
    return undefined;
  }

  return {
    depletionRule: cloneDepletionRule(depletionRule),
    recordedAvailableQuantity: roundQuantity(recordedAvailableQuantity),
    completedIntervals,
    estimatedConsumedQuantity,
    estimatedCurrentQuantity,
    estimatedDepletionAt,
  };
}

export function calculateGroupedDepletionForecast(
  depletionRule: DepletionRulePrimitives | undefined,
  inputs: DepletionForecastInput[],
  referenceDate: Date = new Date(),
): DepletionForecast | undefined {
  if (!depletionRule?.enabled || !isForecastableRule(depletionRule)) {
    return undefined;
  }

  if (inputs.length === 0) {
    return {
      depletionRule: cloneDepletionRule(depletionRule),
      recordedAvailableQuantity: 0,
      completedIntervals: 0,
      estimatedConsumedQuantity: 0,
      estimatedCurrentQuantity: 0,
      estimatedDepletionAt: mexicoCityDateLabel(referenceDate),
    };
  }

  const forecasts = inputs.map((input) =>
    calculateDepletionForecast(
      {
        ...depletionRule,
        anchorDate: input.startDate ?? depletionRule.anchorDate,
      },
      input.recordedAvailableQuantity,
      referenceDate,
    ),
  );

  const definedForecasts = forecasts.filter(
    (forecast): forecast is DepletionForecast => Boolean(forecast),
  );
  if (definedForecasts.length !== forecasts.length) {
    return undefined;
  }

  const recordedAvailableQuantity = roundQuantity(
    definedForecasts.reduce(
      (total, forecast) => total + forecast.recordedAvailableQuantity,
      0,
    ),
  );
  const estimatedConsumedQuantity = roundQuantity(
    definedForecasts.reduce(
      (total, forecast) => total + forecast.estimatedConsumedQuantity,
      0,
    ),
  );
  const estimatedCurrentQuantity = roundQuantity(
    definedForecasts.reduce(
      (total, forecast) => total + forecast.estimatedCurrentQuantity,
      0,
    ),
  );
  const estimatedDepletionAt =
    estimatedCurrentQuantity <= 0
      ? mexicoCityDateLabel(referenceDate)
      : new Date(
          Math.max(
            ...definedForecasts
              .filter((forecast) => forecast.estimatedCurrentQuantity > 0)
              .map((forecast) => forecast.estimatedDepletionAt.getTime()),
          ),
        );

  return {
    depletionRule: cloneDepletionRule(depletionRule),
    recordedAvailableQuantity,
    completedIntervals: Math.max(
      ...definedForecasts.map((forecast) => forecast.completedIntervals),
    ),
    estimatedConsumedQuantity,
    estimatedCurrentQuantity,
    estimatedDepletionAt,
  };
}

function countCompletedIntervals(
  anchorDate: Date,
  referenceDate: Date,
  everyAmount: number,
  everyPeriod: DepletionPeriod,
): number {
  const referenceDay = mexicoCityDateLabel(referenceDate);
  const anchorDay = utcDateLabel(anchorDate);
  if (referenceDay < anchorDay) {
    return 0;
  }

  if (everyPeriod !== 'month') {
    const daysPerInterval = everyAmount * (everyPeriod === 'week' ? 7 : 1);
    return Math.floor(
      (referenceDay.getTime() - anchorDay.getTime()) /
        DAY_IN_MS /
        daysPerInterval,
    );
  }

  const monthGap =
    (referenceDay.getUTCFullYear() - anchorDay.getUTCFullYear()) * 12 +
    referenceDay.getUTCMonth() -
    anchorDay.getUTCMonth();
  let completedIntervals = 0;
  let upperBound = Math.floor(monthGap / everyAmount) + 1;

  while (completedIntervals + 1 < upperBound) {
    const candidate = Math.floor((completedIntervals + upperBound) / 2);
    if (addCivilMonths(anchorDay, candidate * everyAmount) <= referenceDay) {
      completedIntervals = candidate;
    } else {
      upperBound = candidate;
    }
  }

  return completedIntervals;
}

function addIntervals(
  anchorDate: Date,
  amount: number,
  period: DepletionPeriod,
): Date {
  if (period === 'day') {
    return addCivilDays(anchorDate, amount);
  }

  if (period === 'week') {
    return addCivilDays(anchorDate, amount * 7);
  }

  return addCivilMonths(anchorDate, amount);
}

function isForecastableRule(rule: DepletionRulePrimitives): boolean {
  return (
    Number.isSafeInteger(rule.everyAmount) &&
    rule.everyAmount > 0 &&
    Number.isFinite(rule.consumeAmount) &&
    rule.consumeAmount > 0 &&
    isSupportedCivilDateLabel(rule.anchorDate) &&
    isSupportedCivilDateLabel(
      addIntervals(rule.anchorDate, rule.everyAmount, rule.everyPeriod),
    )
  );
}

function roundQuantity(value: number): number {
  return Number(value.toFixed(2));
}

function cloneDepletionRule(
  rule: DepletionRulePrimitives,
): DepletionRulePrimitives {
  return {
    ...rule,
    anchorDate: new Date(rule.anchorDate),
  };
}
