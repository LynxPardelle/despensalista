import { FastifyRequest } from 'fastify';
import { CreateProductUseCase } from '../../../application/use-cases/create-product.use-case';
import { GetProductByIdUseCase } from '../../../application/use-cases/get-product-by-id.use-case';
import { GetProductsByUserUseCase } from '../../../application/use-cases/get-products-by-user.use-case';
import { ResolveHouseholdPantryAccessUseCase } from '../../../application/use-cases/household.use-cases';
import { UpdateProductQuantityUseCase } from '../../../application/use-cases/update-product-quantity.use-case';
import { Product } from '../../../domain/entities/product.entity';
import {
  ProductCategory,
  ProductStatus,
  QuantityUnit,
} from '../../../domain/enums';
import { AuthCookieService } from '../auth/auth-cookie.service';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { ProductsController } from './products.controller';

describe('ProductsController', () => {
  it('requires XSRF before updating legacy product quantity', async () => {
    const { controller, authCookieService, updateProductQuantityUseCase } =
      makeController();
    const request = { method: 'PUT' } as FastifyRequest;

    await controller.updateQuantity(
      'product-1',
      makeCurrentUser('user-1'),
      { quantity: 3 },
      request,
    );

    expect(authCookieService.ensureXsrfForRequest).toHaveBeenCalledWith(
      request,
    );
    expect(updateProductQuantityUseCase.execute).toHaveBeenCalledWith(
      'product-1',
      'user-1',
      3,
    );
  });

  it('updates legacy product quantity under the household owner scope', async () => {
    const {
      controller,
      resolveHouseholdPantryAccessUseCase,
      updateProductQuantityUseCase,
    } = makeController();
    const request = { method: 'PUT' } as FastifyRequest;
    resolveHouseholdPantryAccessUseCase.executeWrite.mockResolvedValueOnce(
      makeHouseholdAccess({
        requesterUserId: 'editor-user',
        pantryOwnerUserId: 'owner-user',
        role: 'editor',
      }),
    );

    await controller.updateQuantity(
      'product-1',
      makeCurrentUser('editor-user'),
      { quantity: 3 },
      request,
    );

    expect(updateProductQuantityUseCase.execute).toHaveBeenCalledWith(
      'product-1',
      'owner-user',
      3,
    );
  });
});

function makeController(): {
  controller: ProductsController;
  authCookieService: jest.Mocked<AuthCookieService>;
  updateProductQuantityUseCase: jest.Mocked<UpdateProductQuantityUseCase>;
  resolveHouseholdPantryAccessUseCase: jest.Mocked<ResolveHouseholdPantryAccessUseCase>;
} {
  const product = Product.fromPrimitives({
    id: 'product-1',
    userId: 'user-1',
    title: 'Arroz',
    status: ProductStatus.AVAILABLE,
    currentQuantity: 3,
    unit: QuantityUnit.KILOGRAM,
    usageRate: {
      amount: 1,
      period: 'month',
    },
    category: ProductCategory.FOOD,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
  });
  const updateProductQuantityUseCase = {
    execute: jest.fn().mockResolvedValue(product),
  } as unknown as jest.Mocked<UpdateProductQuantityUseCase>;
  const authCookieService = {
    ensureXsrfForRequest: jest.fn(),
  } as unknown as jest.Mocked<AuthCookieService>;
  const resolveHouseholdPantryAccessUseCase = {
    executeRead: jest.fn().mockResolvedValue(makeHouseholdAccess()),
    executeWrite: jest.fn().mockResolvedValue(makeHouseholdAccess()),
    executeOwner: jest.fn().mockResolvedValue(makeHouseholdAccess()),
  } as unknown as jest.Mocked<ResolveHouseholdPantryAccessUseCase>;

  return {
    controller: new ProductsController(
      {} as jest.Mocked<CreateProductUseCase>,
      {} as jest.Mocked<GetProductByIdUseCase>,
      updateProductQuantityUseCase,
      {} as jest.Mocked<GetProductsByUserUseCase>,
      resolveHouseholdPantryAccessUseCase,
      authCookieService,
    ),
    authCookieService,
    updateProductQuantityUseCase,
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
