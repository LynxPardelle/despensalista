import { ForbiddenException } from '@nestjs/common';
import type { WasteEvent } from '../../domain/entities/waste-event.entity';
import type { WasteEventRepository } from '../../domain/repositories/waste-event.repository';
import {
  FREE_HOUSEHOLD_PLAN,
  type HouseholdPlanReader,
} from '../ports/household-plan-reader';
import type { MonthlyPurchaseSpendReader } from '../ports/monthly-purchase-spend-reader';
import type { PantryOverview } from '../read-models/pantry-overview.read-model';
import type { GetPantryOverviewUseCase } from './get-pantry-overview.use-case';
import { GetPlusHouseholdSummaryUseCase } from './get-plus-household-summary.use-case';

describe('GetPlusHouseholdSummaryUseCase', () => {
  const date = new Date('2026-12-01T01:00:00.000Z');
  const getPlan: jest.MockedFunction<HouseholdPlanReader['getPlan']> =
    jest.fn();
  const execute = jest.fn<Promise<PantryOverview>, [string]>();
  const findSinceByUserId: jest.MockedFunction<
    WasteEventRepository['findSinceByUserId']
  > = jest.fn();
  const getMonthlyPurchaseSpend: jest.MockedFunction<
    MonthlyPurchaseSpendReader['getMonthlyPurchaseSpend']
  > = jest.fn();
  const summary = new GetPlusHouseholdSummaryUseCase(
    { getPlan },
    { execute } as unknown as GetPantryOverviewUseCase,
    { findSinceByUserId } as unknown as WasteEventRepository,
    { getMonthlyPurchaseSpend },
  );

  beforeEach(() => jest.resetAllMocks());

  it('checks the plan before reading any Plus data', async () => {
    getPlan.mockResolvedValue(FREE_HOUSEHOLD_PLAN);
    await expect(
      summary.execute('household', 'owner', date),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(execute).not.toHaveBeenCalled();
    expect(findSinceByUserId).not.toHaveBeenCalled();
    expect(getMonthlyPurchaseSpend).not.toHaveBeenCalled();
  });

  it('returns weekly actions and actual recorded spend for the local calendar month', async () => {
    getPlan.mockResolvedValue({
      tier: 'plus',
      memberLimit: 5,
      savedListLimit: 15,
      paidThrough: '2026-12-09T00:00:00Z',
    });
    execute.mockResolvedValue({
      items: [
        {
          productTypeId: '1',
          baseName: 'Leche',
          lots: [
            { expiresAt: new Date('2026-11-28T00:00:00Z') },
            { expiresAt: new Date('2026-12-03T00:00:00Z') },
            { expiresAt: new Date('2026-12-08T00:00:00Z') },
          ],
        },
      ],
      shoppingPlanItems: [
        {
          productTypeId: '2',
          baseName: 'Arroz',
          suggestedPurchaseQuantity: 2,
          defaultUnit: 'kg',
          urgency: 'depleted',
        },
      ],
      stapleItems: [
        {
          productTypeId: '2',
          baseName: 'Arroz',
          suggestedPurchaseQuantity: 2,
          defaultUnit: 'kg',
          status: 'low',
        },
      ],
    } as unknown as PantryOverview);
    findSinceByUserId.mockResolvedValue([
      {
        toPrimitives: () => ({
          estimatedLoss: 15,
          occurredAt: new Date('2026-11-29T11:00:00Z'),
        }),
      } as WasteEvent,
    ]);
    getMonthlyPurchaseSpend.mockResolvedValue({
      month: '2026-11',
      amountMinor: 32950,
      pricedItemCount: 4,
      unpricedItemCount: 1,
    });

    await expect(
      summary.execute('household', 'owner', date),
    ).resolves.toMatchObject({
      upcomingExpiration: [
        { productTypeId: '1', name: 'Leche', date: '2026-12-03' },
      ],
      restock: [{ productTypeId: '2', name: 'Arroz', quantity: 2, unit: 'kg' }],
      waste: { count: 1, estimatedLoss: 15 },
      monthlySpend: {
        month: '2026-11',
        amountMinor: 32950,
        pricedItemCount: 4,
        unpricedItemCount: 1,
      },
    });
    expect(getMonthlyPurchaseSpend).toHaveBeenCalledWith('owner', '2026-11');
    expect(findSinceByUserId.mock.calls[0][1].toISOString()).toBe(
      '2026-11-24T01:00:00.000Z',
    );
  });
});
