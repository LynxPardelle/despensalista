import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  ProductType,
  ProductTypeShoppingMetadataPatch,
} from '../../domain/entities/product-type.entity';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { ProductTypeId } from '../../domain/value-objects/product-type-id.vo';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { PRODUCT_TYPE_REPOSITORY, PANTRY_MUTATION_PORT } from '../tokens';
import { PantryMutationPort } from '../ports/pantry-mutation.port';

export interface UpdateProductTypeShoppingMetadataCommand {
  productTypeId: string;
  userId: string;
  shoppingMetadata: ProductTypeShoppingMetadataPatch;
}

@Injectable()
export class UpdateProductTypeShoppingMetadataUseCase {
  constructor(
    @Inject(PRODUCT_TYPE_REPOSITORY)
    private readonly productTypeRepository: ProductTypeRepository,
    @Inject(PANTRY_MUTATION_PORT)
    private readonly pantryMutationPort: PantryMutationPort,
  ) {}

  async execute(
    command: UpdateProductTypeShoppingMetadataCommand,
  ): Promise<ProductType> {
    const productType = await this.findOwnedProductType(
      command.productTypeId,
      command.userId,
    );

    const expected = ProductType.fromPrimitives(productType.toPrimitives());
    productType.updateShoppingMetadata(command.shoppingMetadata);

    return this.pantryMutationPort.updateProductType(expected, productType);
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
