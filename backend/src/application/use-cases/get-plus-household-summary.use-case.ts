import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { WasteEventRepository } from '../../domain/repositories/waste-event.repository';
import {
  civilDayDifference,
  mexicoCityDateLabel,
} from '../../domain/utils/civil-date';
import { UserId } from '../../domain/value-objects/user-id.vo';
import {
  HOUSEHOLD_PLAN_READER,
  type HouseholdPlanReader,
} from '../ports/household-plan-reader';
import {
  MONTHLY_PURCHASE_SPEND_READER,
  type MonthlyPurchaseSpendReader,
} from '../ports/monthly-purchase-spend-reader';
import { WASTE_EVENT_REPOSITORY } from '../tokens';
import { GetPantryOverviewUseCase } from './get-pantry-overview.use-case';

const WEEK_DAYS = 7;
const ACTION_LIMIT = 8;

export class PlusRequiredException extends ForbiddenException {
  readonly code = 'PLUS_REQUIRED';

  constructor() {
    super('Plus Hogar is required for the weekly summary');
  }
}

@Injectable()
export class GetPlusHouseholdSummaryUseCase {
  constructor(
    @Inject(HOUSEHOLD_PLAN_READER) private readonly plans: HouseholdPlanReader,
    private readonly overview: GetPantryOverviewUseCase,
    @Inject(WASTE_EVENT_REPOSITORY)
    private readonly wasteEvents: WasteEventRepository,
    @Inject(MONTHLY_PURCHASE_SPEND_READER)
    private readonly monthlySpend: MonthlyPurchaseSpendReader,
  ) {}

  async execute(
    householdId: string,
    ownerUserId: string,
    referenceDate = new Date(),
  ) {
    if ((await this.plans.getPlan(householdId)).tier === 'free') {
      throw new PlusRequiredException();
    }

    const weekStart = new Date(
      referenceDate.getTime() - WEEK_DAYS * 86_400_000,
    );
    const month = mexicoCityDateLabel(referenceDate).toISOString().slice(0, 7);
    const [overview, waste, monthlySpend] = await Promise.all([
      this.overview.execute(ownerUserId, referenceDate),
      this.wasteEvents.findSinceByUserId(
        UserId.fromString(ownerUserId),
        weekStart,
      ),
      this.monthlySpend.getMonthlyPurchaseSpend(ownerUserId, month),
    ]);

    const upcomingExpiration = overview.items
      .flatMap(({ productTypeId, baseName, lots }) => {
        const dates = lots.flatMap(({ expiresAt }) => {
          if (!expiresAt) return [];
          const days = civilDayDifference(referenceDate, expiresAt);
          return days >= 0 && days <= WEEK_DAYS
            ? [expiresAt.toISOString().slice(0, 10)]
            : [];
        });
        const date = dates.sort()[0];
        return date ? [{ productTypeId, name: baseName, date }] : [];
      })
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(0, ACTION_LIMIT);

    const restock = new Map<
      string,
      { productTypeId: string; name: string; quantity: number; unit: string }
    >();
    for (const item of [
      ...overview.stapleItems.filter(({ status }) => status !== 'available'),
      ...overview.shoppingPlanItems,
    ]) {
      if (restock.size === ACTION_LIMIT) break;
      if (
        !restock.has(item.productTypeId) &&
        item.suggestedPurchaseQuantity > 0
      ) {
        restock.set(item.productTypeId, {
          productTypeId: item.productTypeId,
          name: item.baseName,
          quantity: item.suggestedPurchaseQuantity,
          unit: item.defaultUnit,
        });
      }
    }

    const wasteInWeek = waste
      .map((event) => event.toPrimitives())
      .filter(({ occurredAt }) => occurredAt <= referenceDate);
    return {
      generatedAt: referenceDate.toISOString(),
      upcomingExpiration,
      restock: [...restock.values()],
      waste: {
        count: wasteInWeek.length,
        estimatedLoss: Number(
          wasteInWeek
            .reduce((total, item) => total + (item.estimatedLoss ?? 0), 0)
            .toFixed(2),
        ),
      },
      monthlySpend,
    };
  }
}
