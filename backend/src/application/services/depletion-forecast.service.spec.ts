import { QuantityUnit } from '../../domain/enums';
import {
  calculateDepletionForecast,
  calculateGroupedDepletionForecast,
} from './depletion-forecast.service';

describe('calculateDepletionForecast', () => {
  it('calculates completed weekly intervals', () => {
    const forecast = calculateDepletionForecast(
      {
        enabled: true,
        consumeAmount: 2,
        unit: QuantityUnit.PIECE,
        everyAmount: 1,
        everyPeriod: 'week',
        anchorDate: new Date('2026-04-03T00:00:00.000Z'),
      },
      10,
      new Date('2026-04-24T12:00:00.000Z'),
    );

    expect(forecast).toMatchObject({
      completedIntervals: 3,
      estimatedConsumedQuantity: 6,
      estimatedCurrentQuantity: 4,
    });
  });

  it('does not consume before the first full interval completes', () => {
    const forecast = calculateDepletionForecast(
      {
        enabled: true,
        consumeAmount: 1,
        unit: QuantityUnit.LITER,
        everyAmount: 1,
        everyPeriod: 'month',
        anchorDate: new Date('2026-04-01T00:00:00.000Z'),
      },
      3,
      new Date('2026-04-24T12:00:00.000Z'),
    );

    expect(forecast).toMatchObject({
      completedIntervals: 0,
      estimatedConsumedQuantity: 0,
      estimatedCurrentQuantity: 3,
    });
  });

  it('waits for Mexico City midnight before completing a daily interval', () => {
    const rule = {
      enabled: true,
      consumeAmount: 1,
      unit: QuantityUnit.PIECE,
      everyAmount: 1,
      everyPeriod: 'day' as const,
      anchorDate: new Date('2026-04-28T00:00:00.000Z'),
    };

    expect(
      calculateDepletionForecast(rule, 2, new Date('2026-04-29T00:00:00.000Z')),
    ).toMatchObject({
      completedIntervals: 0,
      estimatedConsumedQuantity: 0,
      estimatedCurrentQuantity: 2,
      estimatedDepletionAt: new Date('2026-04-30T00:00:00.000Z'),
    });
    expect(
      calculateDepletionForecast(rule, 2, new Date('2026-04-29T06:00:00.000Z')),
    ).toMatchObject({
      completedIntervals: 1,
      estimatedConsumedQuantity: 1,
      estimatedCurrentQuantity: 1,
    });
  });

  it('clamps a January 31 monthly interval to February and returns to March 31', () => {
    const rule = {
      enabled: true,
      consumeAmount: 1,
      unit: QuantityUnit.PIECE,
      everyAmount: 1,
      everyPeriod: 'month' as const,
      anchorDate: new Date('2026-01-31T00:00:00.000Z'),
    };

    expect(
      calculateDepletionForecast(rule, 2, new Date('2026-02-28T06:00:00.000Z')),
    ).toMatchObject({
      completedIntervals: 1,
      estimatedConsumedQuantity: 1,
      estimatedDepletionAt: new Date('2026-03-31T00:00:00.000Z'),
    });
    expect(
      calculateDepletionForecast(
        { ...rule, anchorDate: new Date('2028-01-31T00:00:00.000Z') },
        2,
        new Date('2028-02-29T06:00:00.000Z'),
      )?.completedIntervals,
    ).toBe(1);
  });

  it('counts month-end intervals only after their clamped calendar day', () => {
    const rule = {
      enabled: true,
      consumeAmount: 1,
      unit: QuantityUnit.PIECE,
      everyAmount: 1,
      everyPeriod: 'month' as const,
      anchorDate: new Date('2026-01-31T00:00:00.000Z'),
    };

    expect(
      calculateDepletionForecast(rule, 10, new Date('2026-02-27T06:00:00.000Z'))
        ?.completedIntervals,
    ).toBe(0);
    expect(
      calculateDepletionForecast(rule, 10, new Date('2026-02-28T06:00:00.000Z'))
        ?.completedIntervals,
    ).toBe(1);
    expect(
      calculateDepletionForecast(rule, 10, new Date('2026-03-30T06:00:00.000Z'))
        ?.completedIntervals,
    ).toBe(1);
    expect(
      calculateDepletionForecast(rule, 10, new Date('2026-03-31T06:00:00.000Z'))
        ?.completedIntervals,
    ).toBe(2);
  });

  it('handles a distant historical daily or weekly anchor', () => {
    const baseRule = {
      enabled: true,
      consumeAmount: 1,
      unit: QuantityUnit.PIECE,
      everyAmount: 1,
      anchorDate: new Date('1900-01-01T00:00:00.000Z'),
    };
    const todayInMexico = new Date('2026-10-05T06:00:00.000Z');

    expect(
      calculateDepletionForecast(
        { ...baseRule, everyPeriod: 'day' },
        100_000,
        todayInMexico,
      )?.completedIntervals,
    ).toBe(46_298);
    expect(
      calculateDepletionForecast(
        { ...baseRule, everyPeriod: 'week' },
        100_000,
        todayInMexico,
      )?.completedIntervals,
    ).toBe(6_614);
  });

  it('omits an estimate when a later projected date exceeds the Date range', () => {
    const rule = {
      enabled: true,
      consumeAmount: 1,
      unit: QuantityUnit.PIECE,
      everyAmount: 20_000_000,
      everyPeriod: 'day' as const,
      anchorDate: new Date('2026-04-28T00:00:00.000Z'),
    };
    const referenceDate = new Date('2026-04-28T12:00:00.000Z');

    expect(calculateDepletionForecast(rule, 6, referenceDate)).toBeUndefined();
    expect(
      calculateGroupedDepletionForecast(
        rule,
        [{ recordedAvailableQuantity: 6 }],
        referenceDate,
      ),
    ).toBeUndefined();
    expect(calculateDepletionForecast(rule, 0, referenceDate)).toBeUndefined();
    expect(
      calculateGroupedDepletionForecast(rule, [], referenceDate),
    ).toBeUndefined();
  });

  it('reports the Mexico City date label when an item is depleted or has no lots', () => {
    const rule = {
      enabled: true,
      consumeAmount: 1,
      unit: QuantityUnit.PIECE,
      everyAmount: 1,
      everyPeriod: 'day' as const,
      anchorDate: new Date('2026-04-26T00:00:00.000Z'),
    };
    const eveningInMexico = new Date('2026-04-29T00:00:00.000Z');

    expect(
      calculateDepletionForecast(rule, 1, eveningInMexico)
        ?.estimatedDepletionAt,
    ).toEqual(new Date('2026-04-28T00:00:00.000Z'));
    expect(
      calculateGroupedDepletionForecast(rule, [], eveningInMexico)
        ?.estimatedDepletionAt,
    ).toEqual(new Date('2026-04-28T00:00:00.000Z'));
  });

  it('floors estimated current quantity at zero', () => {
    const forecast = calculateDepletionForecast(
      {
        enabled: true,
        consumeAmount: 1,
        unit: QuantityUnit.LITER,
        everyAmount: 1,
        everyPeriod: 'month',
        anchorDate: new Date('2026-01-24T00:00:00.000Z'),
      },
      2,
      new Date('2026-04-24T12:00:00.000Z'),
    );

    expect(forecast).toMatchObject({
      completedIntervals: 3,
      estimatedConsumedQuantity: 3,
      estimatedCurrentQuantity: 0,
    });
  });

  it('returns undefined when the depletion rule is disabled or missing', () => {
    expect(calculateDepletionForecast(undefined, 10)).toBeUndefined();
    expect(
      calculateDepletionForecast(
        {
          enabled: false,
          consumeAmount: 1,
          unit: QuantityUnit.LITER,
          everyAmount: 1,
          everyPeriod: 'month',
          anchorDate: new Date('2026-01-24T00:00:00.000Z'),
        },
        10,
      ),
    ).toBeUndefined();
  });
});
