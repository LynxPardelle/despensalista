import { Inject, Injectable } from '@nestjs/common';
import { InventoryLot } from '../../domain/entities/inventory-lot.entity';
import { InventoryLotRepository } from '../../domain/repositories/inventory-lot.repository';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { INVENTORY_LOT_REPOSITORY } from '../tokens';
import {
  collectionPage,
  CollectionPageOptions,
} from '../utils/collection-page';

@Injectable()
export class ListInventoryLotsUseCase {
  constructor(
    @Inject(INVENTORY_LOT_REPOSITORY)
    private readonly inventoryLotRepository: InventoryLotRepository,
  ) {}

  async execute(userId: string): Promise<InventoryLot[]> {
    return this.inventoryLotRepository.findByUserId(UserId.fromString(userId));
  }

  async page(
    userId: string,
    options: CollectionPageOptions,
    productTypeId?: string,
  ) {
    const items = await this.execute(userId);
    return collectionPage(
      items.filter(
        (item) =>
          !productTypeId || item.productTypeId.toString() === productTypeId,
      ),
      JSON.stringify([userId, 'lots', productTypeId ?? '']),
      options,
    );
  }
}
