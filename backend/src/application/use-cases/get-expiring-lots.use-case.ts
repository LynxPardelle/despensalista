import { Inject, Injectable } from '@nestjs/common';
import { InventoryLotRepository } from '../../domain/repositories/inventory-lot.repository';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { civilDayDifference } from '../../domain/utils/civil-date';
import { INVENTORY_LOT_REPOSITORY, PRODUCT_TYPE_REPOSITORY } from '../tokens';
import { ExpiringProductGroup } from '../read-models/pantry-overview.read-model';
import { buildPantryOverview } from '../utils/pantry-overview.builder';

@Injectable()
export class GetExpiringLotsUseCase {
  constructor(
    @Inject(PRODUCT_TYPE_REPOSITORY)
    private readonly productTypeRepository: ProductTypeRepository,
    @Inject(INVENTORY_LOT_REPOSITORY)
    private readonly inventoryLotRepository: InventoryLotRepository,
  ) {}

  async execute(
    userId: string,
    days: number = 7,
  ): Promise<ExpiringProductGroup[]> {
    const normalizedUserId = UserId.fromString(userId);
    const [productTypes, inventoryLots] = await Promise.all([
      this.productTypeRepository.findByUserId(normalizedUserId),
      this.inventoryLotRepository.findByUserId(normalizedUserId),
    ]);

    const referenceDate = new Date();
    const overview = buildPantryOverview(
      userId,
      productTypes,
      inventoryLots,
      referenceDate,
    );

    return overview.items
      .map((group) => ({
        productTypeId: group.productTypeId,
        baseName: group.baseName,
        category: group.category,
        lots: group.lots.filter((lot) => {
          if (!lot.expiresAt) {
            return false;
          }

          return (
            civilDayDifference(referenceDate, new Date(lot.expiresAt)) <= days
          );
        }),
      }))
      .filter((group) => group.lots.length > 0)
      .map((group) => ({
        ...group,
        totalExpiringQuantity: Number(
          group.lots.reduce((sum, lot) => sum + lot.quantity, 0).toFixed(2),
        ),
        nextExpirationAt: group.lots[0]?.expiresAt,
        lotCount: group.lots.length,
      }));
  }
}
