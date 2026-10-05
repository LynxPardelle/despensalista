import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ProductType } from '../../domain/entities/product-type.entity';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { ProductTypeId } from '../../domain/value-objects/product-type-id.vo';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { PRODUCT_TYPE_REPOSITORY } from '../tokens';
import {
  PantryMutationConflictError,
  PantryMutationPort,
} from '../ports/pantry-mutation.port';
import { PANTRY_MUTATION_PORT } from '../tokens';

export interface ArchiveProductTypeCommand {
  productTypeId: string;
  userId: string;
  reason?: string;
}

@Injectable()
export class ArchiveProductTypeUseCase {
  constructor(
    @Inject(PRODUCT_TYPE_REPOSITORY)
    private readonly productTypeRepository: ProductTypeRepository,
    @Inject(PANTRY_MUTATION_PORT)
    private readonly pantryMutationPort: PantryMutationPort,
  ) {}

  async execute(command: ArchiveProductTypeCommand): Promise<ProductType> {
    const productType = await this.findOwnedProductType(
      command.productTypeId,
      command.userId,
    );

    const expected = ProductType.fromPrimitives(productType.toPrimitives());
    productType.archive(command.reason);

    try {
      return await this.pantryMutationPort.archiveProductType(
        expected,
        productType,
      );
    } catch (error) {
      if (error instanceof PantryMutationConflictError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  private async findOwnedProductType(
    productTypeId: string,
    userId: string,
  ): Promise<ProductType> {
    const productType = await this.productTypeRepository.findById(
      ProductTypeId.fromString(productTypeId),
    );

    if (
      !productType ||
      productType.userId.toString() !== UserId.fromString(userId).toString()
    ) {
      throw new NotFoundException('Product type not found');
    }

    return productType;
  }
}
