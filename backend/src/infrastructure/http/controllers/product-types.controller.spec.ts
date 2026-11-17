import { ForbiddenException } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ArchiveProductTypeUseCase } from '../../../application/use-cases/archive-product-type.use-case';
import { CreateProductTypeUseCase } from '../../../application/use-cases/create-product-type.use-case';
import { DeleteProductTypeUseCase } from '../../../application/use-cases/delete-product-type.use-case';
import { GetProductTypeByIdUseCase } from '../../../application/use-cases/get-product-type-by-id.use-case';
import { ResolveHouseholdPantryAccessUseCase } from '../../../application/use-cases/household.use-cases';
import { RestoreProductTypeUseCase } from '../../../application/use-cases/restore-product-type.use-case';
import { SearchProductTypesUseCase } from '../../../application/use-cases/search-product-types.use-case';
import { UpdateProductTypeDepletionRuleUseCase } from '../../../application/use-cases/update-product-type-depletion-rule.use-case';
import { UpdateProductTypePlanningSettingsUseCase } from '../../../application/use-cases/update-product-type-planning-settings.use-case';
import { UpdateProductTypeShoppingMetadataUseCase } from '../../../application/use-cases/update-product-type-shopping-metadata.use-case';
import { ProductType } from '../../../domain/entities/product-type.entity';
import { ProductCategory, QuantityUnit } from '../../../domain/enums';
import { AuthCookieService } from '../auth/auth-cookie.service';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { ProductTypesController } from './product-types.controller';

describe('ProductTypesController archive and planning endpoints', () => {
  it('requires XSRF and updates planning settings for the current user', async () => {
    const {
      controller,
      authCookieService,
      updateProductTypePlanningSettingsUseCase,
    } = makeController();
    const request = { method: 'PATCH' } as FastifyRequest;

    await controller.updatePlanningSettings(
      'type-1',
      makeCurrentUser('user-1'),
      {
        planningEnabled: false,
        shoppingPlanLeadDaysOverride: 10,
      },
      request,
    );

    expect(authCookieService.ensureXsrfForRequest).toHaveBeenCalledWith(
      request,
    );
    expect(
      updateProductTypePlanningSettingsUseCase.execute,
    ).toHaveBeenCalledWith({
      productTypeId: 'type-1',
      userId: 'user-1',
      planningSettings: {
        planningEnabled: false,
        shoppingPlanLeadDaysOverride: 10,
      },
    });
  });

  it('requires XSRF and updates shopping metadata for the current user', async () => {
    const {
      controller,
      authCookieService,
      updateProductTypeShoppingMetadataUseCase,
    } = makeController();
    const request = { method: 'PATCH' } as FastifyRequest;

    await controller.updateShoppingMetadata(
      'type-1',
      makeCurrentUser('user-1'),
      {
        storageLocation: 'Despensa',
        shoppingLocation: 'Mercado',
        householdStaple: true,
        buyOnlyOnPromo: true,
        estimatedUnitPrice: 36.5,
      },
      request,
    );

    expect(authCookieService.ensureXsrfForRequest).toHaveBeenCalledWith(
      request,
    );
    expect(
      updateProductTypeShoppingMetadataUseCase.execute,
    ).toHaveBeenCalledWith({
      productTypeId: 'type-1',
      userId: 'user-1',
      shoppingMetadata: {
        storageLocation: 'Despensa',
        shoppingLocation: 'Mercado',
        householdStaple: true,
        buyOnlyOnPromo: true,
        estimatedUnitPrice: 36.5,
      },
    });
  });

  it('requires XSRF before permanently deleting an archived product type', async () => {
    const { controller, authCookieService, deleteProductTypeUseCase } =
      makeController();
    const request = { method: 'DELETE' } as FastifyRequest;

    await controller.delete(
      'type-1',
      makeCurrentUser('user-1'),
      {
        confirmationText: 'Detergente',
      },
      request,
    );

    expect(authCookieService.ensureXsrfForRequest).toHaveBeenCalledWith(
      request,
    );
    expect(deleteProductTypeUseCase.execute).toHaveBeenCalledWith({
      productTypeId: 'type-1',
      userId: 'user-1',
      confirmationText: 'Detergente',
    });
  });

  it('blocks viewer writes before mutating product types', async () => {
    const {
      controller,
      resolveHouseholdPantryAccessUseCase,
      updateProductTypePlanningSettingsUseCase,
    } = makeController();
    const request = { method: 'PATCH' } as FastifyRequest;
    resolveHouseholdPantryAccessUseCase.executeWrite.mockRejectedValueOnce(
      new ForbiddenException('Household viewers cannot change pantry data'),
    );

    await expect(
      controller.updatePlanningSettings(
        'type-1',
        makeCurrentUser('viewer-user'),
        {
          planningEnabled: false,
        },
        request,
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(
      resolveHouseholdPantryAccessUseCase.executeWrite,
    ).toHaveBeenCalledWith('viewer-user');
    expect(
      updateProductTypePlanningSettingsUseCase.execute,
    ).not.toHaveBeenCalled();
  });
});

function makeController(): {
  controller: ProductTypesController;
  authCookieService: jest.Mocked<AuthCookieService>;
  updateProductTypePlanningSettingsUseCase: jest.Mocked<UpdateProductTypePlanningSettingsUseCase>;
  updateProductTypeShoppingMetadataUseCase: jest.Mocked<UpdateProductTypeShoppingMetadataUseCase>;
  deleteProductTypeUseCase: jest.Mocked<DeleteProductTypeUseCase>;
  resolveHouseholdPantryAccessUseCase: jest.Mocked<ResolveHouseholdPantryAccessUseCase>;
} {
  const productType = ProductType.fromPrimitives({
    id: 'type-1',
    userId: 'user-1',
    baseName: 'Detergente',
    category: ProductCategory.CLEANING,
    defaultUnit: QuantityUnit.LITER,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt: new Date('2026-04-01T00:00:00.000Z'),
  });
  const createProductTypeUseCase = {} as jest.Mocked<CreateProductTypeUseCase>;
  const getProductTypeByIdUseCase =
    {} as jest.Mocked<GetProductTypeByIdUseCase>;
  const searchProductTypesUseCase =
    {} as jest.Mocked<SearchProductTypesUseCase>;
  const updateProductTypeDepletionRuleUseCase =
    {} as jest.Mocked<UpdateProductTypeDepletionRuleUseCase>;
  const updateProductTypePlanningSettingsUseCase = {
    execute: jest.fn().mockResolvedValue(productType),
  } as unknown as jest.Mocked<UpdateProductTypePlanningSettingsUseCase>;
  const updateProductTypeShoppingMetadataUseCase = {
    execute: jest.fn().mockResolvedValue(productType),
  } as unknown as jest.Mocked<UpdateProductTypeShoppingMetadataUseCase>;
  const archiveProductTypeUseCase = {
    execute: jest.fn().mockResolvedValue(productType),
  } as unknown as jest.Mocked<ArchiveProductTypeUseCase>;
  const restoreProductTypeUseCase = {
    execute: jest.fn().mockResolvedValue(productType),
  } as unknown as jest.Mocked<RestoreProductTypeUseCase>;
  const deleteProductTypeUseCase = {
    execute: jest.fn(),
  } as unknown as jest.Mocked<DeleteProductTypeUseCase>;
  const resolveHouseholdPantryAccessUseCase = {
    executeRead: jest.fn().mockResolvedValue(makeHouseholdAccess()),
    executeWrite: jest.fn().mockResolvedValue(makeHouseholdAccess()),
    executeOwner: jest.fn().mockResolvedValue(makeHouseholdAccess()),
  } as unknown as jest.Mocked<ResolveHouseholdPantryAccessUseCase>;
  const authCookieService = {
    ensureXsrfForRequest: jest.fn(),
  } as unknown as jest.Mocked<AuthCookieService>;

  return {
    controller: new ProductTypesController(
      createProductTypeUseCase,
      getProductTypeByIdUseCase,
      searchProductTypesUseCase,
      updateProductTypeDepletionRuleUseCase,
      updateProductTypePlanningSettingsUseCase,
      updateProductTypeShoppingMetadataUseCase,
      archiveProductTypeUseCase,
      restoreProductTypeUseCase,
      deleteProductTypeUseCase,
      resolveHouseholdPantryAccessUseCase,
      authCookieService,
    ),
    authCookieService,
    updateProductTypePlanningSettingsUseCase,
    updateProductTypeShoppingMetadataUseCase,
    deleteProductTypeUseCase,
    resolveHouseholdPantryAccessUseCase,
  };
}

function makeCurrentUser(userId: string): AuthenticatedUser {
  return {
    userId,
    authSubjectId: `${userId}-subject`,
  };
}

function makeHouseholdAccess(
  overrides: Partial<{
    requesterUserId: string;
    householdId: string;
    pantryOwnerUserId: string;
    role: 'owner' | 'editor' | 'viewer';
  }> = {},
) {
  return {
    requesterUserId: 'user-1',
    householdId: 'household-1',
    pantryOwnerUserId: 'user-1',
    role: 'owner' as const,
    joinedAt: new Date('2026-11-16T00:00:00.000Z'),
    ...overrides,
  };
}
