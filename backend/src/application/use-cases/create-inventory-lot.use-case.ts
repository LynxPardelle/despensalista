import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryLot } from '../../domain/entities/inventory-lot.entity';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { ProductTypeId } from '../../domain/value-objects/product-type-id.vo';
import { UserId } from '../../domain/value-objects/user-id.vo';
import {
  PantryMutationConflictError,
  PantryMutationPort,
  PantryQuotaExceededError,
} from '../ports/pantry-mutation.port';
import { PANTRY_MUTATION_PORT, PRODUCT_TYPE_REPOSITORY } from '../tokens';
import { parseQuantityUnit } from '../utils/enum-parsers';

export interface CreateInventoryLotCommand {
  userId: string;
  productTypeId: string;
  variantName?: string;
  quantity: number;
  unit: string;
  expiresAt?: Date;
  purchaseDate?: Date;
}

@Injectable()
export class CreateInventoryLotUseCase {
  constructor(
    @Inject(PRODUCT_TYPE_REPOSITORY)
    private readonly productTypeRepository: ProductTypeRepository,
    @Inject(PANTRY_MUTATION_PORT)
    private readonly pantryMutationPort: PantryMutationPort,
  ) {}

  async execute(command: CreateInventoryLotCommand): Promise<InventoryLot> {
    const userId = UserId.fromString(command.userId);
    const productType = await this.productTypeRepository.findById(
      ProductTypeId.fromString(command.productTypeId),
    );

    if (!productType || productType.userId.toString() !== userId.toString()) {
      throw new NotFoundException('Product type not found for this user');
    }

    if (productType.isArchived()) {
      throw new BadRequestException(
        'Inventory lots cannot be created for archived product types',
      );
    }

    const unit = parseQuantityUnit(command.unit);

    if (productType.defaultUnit !== unit) {
      throw new BadRequestException(
        `Lot unit must match product type default unit (${productType.defaultUnit})`,
      );
    }

    const inventoryLot = InventoryLot.create(
      userId,
      productType.id,
      command.variantName,
      command.quantity,
      unit,
      command.expiresAt,
      command.purchaseDate,
    );

    try {
      return await this.pantryMutationPort.createInventoryLot(inventoryLot);
    } catch (error) {
      if (
        error instanceof PantryQuotaExceededError ||
        error instanceof PantryMutationConflictError
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }
}
