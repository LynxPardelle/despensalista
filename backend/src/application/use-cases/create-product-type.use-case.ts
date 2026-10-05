import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  ProductType,
  ProductTypeShoppingMetadataPatch,
} from '../../domain/entities/product-type.entity';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { UserId } from '../../domain/value-objects/user-id.vo';
import {
  PantryMutationConflictError,
  PantryMutationPort,
  PantryQuotaExceededError,
} from '../ports/pantry-mutation.port';
import { PANTRY_MUTATION_PORT, PRODUCT_TYPE_REPOSITORY } from '../tokens';
import {
  DepletionRuleInput,
  parseDefaultDepletionRule,
  parseProductCategory,
  parseQuantityUnit,
} from '../utils/enum-parsers';

export interface CreateProductTypeCommand {
  userId: string;
  baseName: string;
  category: string;
  defaultUnit: string;
  defaultDepletionRule?: DepletionRuleInput;
  shoppingMetadata?: ProductTypeShoppingMetadataPatch;
}

@Injectable()
export class CreateProductTypeUseCase {
  constructor(
    @Inject(PRODUCT_TYPE_REPOSITORY)
    private readonly productTypeRepository: ProductTypeRepository,
    @Inject(PANTRY_MUTATION_PORT)
    private readonly pantryMutationPort: PantryMutationPort,
  ) {}

  async execute(command: CreateProductTypeCommand): Promise<ProductType> {
    const userId = UserId.fromString(command.userId);
    const existingProductType = await this.productTypeRepository.findByBaseName(
      userId,
      command.baseName,
    );

    if (existingProductType) {
      throw new ConflictException('Product type already exists for this user');
    }

    const defaultUnit = parseQuantityUnit(command.defaultUnit);
    const productType = ProductType.create(
      userId,
      command.baseName,
      parseProductCategory(command.category),
      defaultUnit,
      parseDefaultDepletionRule(command.defaultDepletionRule, defaultUnit),
      command.shoppingMetadata,
    );

    try {
      return await this.pantryMutationPort.createProductType(productType);
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
