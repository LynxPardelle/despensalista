import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  GoneException,
  Get,
  Header,
  Headers,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FastifyReply, FastifyRequest } from 'fastify';
import { CloseShoppingPurchaseUseCase } from '../../../application/use-cases/close-shopping-purchase.use-case';
import { GetArchivedPantryItemsUseCase } from '../../../application/use-cases/get-archived-pantry-items.use-case';
import { GetPantryOverviewUseCase } from '../../../application/use-cases/get-pantry-overview.use-case';
import { GetUserProfileUseCase } from '../../../application/use-cases/get-user-profile.use-case';
import { GetWasteOverviewUseCase } from '../../../application/use-cases/get-waste-overview.use-case';
import {
  RecordHouseholdActivityUseCase,
  ResolveHouseholdPantryAccessUseCase,
} from '../../../application/use-cases/household.use-cases';
import {
  CreateShoppingShareUseCase,
  ListActiveShoppingSharesUseCase,
  RevokeShoppingShareByIdUseCase,
  RevokeShoppingShareUseCase,
} from '../../../application/use-cases/shopping-share.use-cases';
import {
  CreateShoppingListUseCase,
  DeleteShoppingListUseCase,
  ListShoppingListsUseCase,
} from '../../../application/use-cases/shopping-list.use-cases';
import { ShoppingShareNotFoundError } from '../../../application/use-cases/shopping-share.errors';
import {
  MAX_ACTIVE_INVENTORY_LOTS_PER_USER,
  MAX_ACTIVE_PRODUCT_TYPES_PER_USER,
  MAX_ARCHIVED_INVENTORY_LOTS_PER_USER,
  MAX_ARCHIVED_PANTRY_PAGE_SIZE,
  MAX_ARCHIVED_PRODUCT_TYPES_PER_USER,
  MAX_INVENTORY_LOTS_PER_PRODUCT_TYPE,
  MAX_SAVED_SHOPPING_LIST_ITEMS,
  MAX_SAVED_SHOPPING_LISTS_PER_USER,
  MAX_PRODUCT_TYPE_SEARCH_RESULTS,
  MAX_SHOPPING_CHECKOUT_ITEMS,
} from '../../../application/constants/query-limits';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { AuthCookieService } from '../auth/auth-cookie.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { ArchivedPantryItemsResponseDto } from '../dtos/archived-pantry-items-response.dto';
import { ArchivedPantryQueryDto } from '../dtos/archived-pantry-query.dto';
import { CheckoutPantryDto } from '../dtos/checkout-pantry.dto';
import { CreateShoppingShareDto } from '../dtos/create-shopping-share.dto';
import { InventoryLotResponseDto } from '../dtos/inventory-lot-response.dto';
import {
  PantryDataLimitsResponseDto,
  PantryExportResponseDto,
} from '../dtos/pantry-export-response.dto';
import { PantryOverviewResponseDto } from '../dtos/pantry-overview-response.dto';
import { ShoppingShareResponseDto } from '../dtos/shopping-share-response.dto';
import {
  CreateShoppingListDto,
  ShoppingListResponseDto,
} from '../dtos/shopping-list.dto';
import { WasteOverviewResponseDto } from '../dtos/waste-overview-response.dto';
import { getRequestId } from '../request-id';
import { InventoryLotMapper } from '../mappers/inventory-lot.mapper';
import { PantryOverviewMapper } from '../mappers/pantry-overview.mapper';
import { ProfileMapper } from '../mappers/profile.mapper';
import { ProductTypeMapper } from '../mappers/product-type.mapper';
import { ArchivedPantryItems } from '../../../application/read-models/archived-pantry-items.read-model';
import { InventoryLot } from '../../../domain/entities/inventory-lot.entity';
import { ProductType } from '../../../domain/entities/product-type.entity';
import { ShoppingList } from '../../../domain/entities/shopping-list.entity';

@Controller('pantry')
@ApiTags('pantry')
@UseGuards(AccessTokenGuard)
export class PantryController {
  private readonly logger = new Logger(PantryController.name);

  constructor(
    private readonly getPantryOverviewUseCase: GetPantryOverviewUseCase,
    private readonly getArchivedPantryItemsUseCase: GetArchivedPantryItemsUseCase,
    private readonly getUserProfileUseCase: GetUserProfileUseCase,
    private readonly getWasteOverviewUseCase: GetWasteOverviewUseCase,
    private readonly closeShoppingPurchaseUseCase: CloseShoppingPurchaseUseCase,
    private readonly createShoppingShareUseCase: CreateShoppingShareUseCase,
    private readonly createShoppingListUseCase: CreateShoppingListUseCase,
    private readonly listActiveShoppingSharesUseCase: ListActiveShoppingSharesUseCase,
    private readonly listShoppingListsUseCase: ListShoppingListsUseCase,
    private readonly revokeShoppingShareByIdUseCase: RevokeShoppingShareByIdUseCase,
    private readonly revokeShoppingShareUseCase: RevokeShoppingShareUseCase,
    private readonly deleteShoppingListUseCase: DeleteShoppingListUseCase,
    private readonly resolveHouseholdPantryAccessUseCase: ResolveHouseholdPantryAccessUseCase,
    private readonly recordHouseholdActivityUseCase: RecordHouseholdActivityUseCase,
    private readonly authCookieService: AuthCookieService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: 'Obtener overview agrupado de la despensa' })
  async overview(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Req() request: FastifyRequest,
  ): Promise<PantryOverviewResponseDto> {
    const requestId = getRequestId(request) ?? 'none';
    this.logger.log(
      `pantry_overview_requested requestId=${requestId} userId=${currentUser.userId}`,
    );
    const access = await this.resolveHouseholdPantryAccessUseCase.executeRead(
      currentUser.userId,
    );
    const overview = await this.getPantryOverviewUseCase.execute(
      access.pantryOwnerUserId,
    );
    const response = PantryOverviewMapper.toResponse(overview);
    this.logger.log(
      `pantry_overview_completed requestId=${requestId} userId=${currentUser.userId} pantryOwnerUserId=${access.pantryOwnerUserId} householdId=${access.householdId} itemCount=${response.items.length}`,
    );
    return response;
  }

  @Get('waste-overview')
  @ApiOperation({ summary: 'Obtener resumen de merma de la despensa' })
  async wasteOverview(
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<WasteOverviewResponseDto> {
    const access = await this.resolveHouseholdPantryAccessUseCase.executeRead(
      currentUser.userId,
    );

    return this.getWasteOverviewUseCase.execute(access.pantryOwnerUserId);
  }

  @Get('archived')
  @ApiOperation({ summary: 'Obtener elementos archivados de la despensa' })
  async archived(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query() query: ArchivedPantryQueryDto,
  ): Promise<ArchivedPantryItemsResponseDto> {
    const access = await this.resolveHouseholdPantryAccessUseCase.executeRead(
      currentUser.userId,
    );
    const archivedItems = await this.getPaginatedArchivedItems(
      access.pantryOwnerUserId,
      query,
    );

    return this.toArchivedResponse(archivedItems);
  }

  @Get('export')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Exportar datos de Despensa Lista del usuario' })
  async exportData(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Req() request: FastifyRequest,
  ): Promise<PantryExportResponseDto> {
    const requestId = getRequestId(request) ?? 'none';
    this.logger.log(
      `pantry_export_requested requestId=${requestId} userId=${currentUser.userId}`,
    );
    const access = await this.resolveHouseholdPantryAccessUseCase.executeRead(
      currentUser.userId,
    );
    const [profile, overview, archivedItems, shoppingLists] = await Promise.all(
      [
        this.getUserProfileUseCase.execute(currentUser.userId),
        this.getPantryOverviewUseCase.execute(access.pantryOwnerUserId),
        this.getArchivedPantryItemsUseCase.execute(access.pantryOwnerUserId),
        this.listShoppingListsUseCase.execute(access.pantryOwnerUserId),
      ],
    );

    const response: PantryExportResponseDto = {
      formatVersion: 1,
      exportedAt: new Date(),
      profile: ProfileMapper.toProfileResponse(profile),
      overview: PantryOverviewMapper.toResponse(overview),
      archived: this.toArchivedResponse(archivedItems),
      shoppingLists: shoppingLists.map((list) =>
        this.toShoppingListResponse(list),
      ),
      limits: this.getPantryDataLimits(),
    };
    this.logger.log(
      `pantry_export_completed requestId=${requestId} userId=${currentUser.userId} pantryOwnerUserId=${access.pantryOwnerUserId} householdId=${access.householdId}`,
    );
    return response;
  }

  @Post('checkout')
  @ApiOperation({ summary: 'Cerrar una compra y registrar lotes' })
  async checkout(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: CheckoutPantryDto,
    @Req() request: FastifyRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<InventoryLotResponseDto[]> {
    this.authCookieService.ensureXsrfForRequest(request);
    const requestId = getRequestId(request) ?? 'none';
    this.logger.log(
      `pantry_checkout_requested requestId=${requestId} userId=${currentUser.userId} itemCount=${dto.items.length}`,
    );
    const access = await this.resolveHouseholdPantryAccessUseCase.executeWrite(
      currentUser.userId,
    );

    const result = await this.closeShoppingPurchaseUseCase.execute({
      userId: access.pantryOwnerUserId,
      idempotencyKey,
      items: dto.items.map((item) => ({
        productTypeId: item.productTypeId,
        variantName: item.variantName,
        quantity: item.quantity,
        unit: item.unit,
        paidUnitPrice: item.paidUnitPrice,
        shoppingLocation: item.shoppingLocation,
        expiresAt: item.expiresAt ? new Date(item.expiresAt) : undefined,
      })),
    });

    reply.header('Idempotency-Key', idempotencyKey ?? '');
    if (result.replayed) {
      reply.header('Idempotency-Replayed', 'true');
    }
    this.logger.log(
      `pantry_checkout_completed requestId=${requestId} userId=${currentUser.userId} pantryOwnerUserId=${access.pantryOwnerUserId} householdId=${access.householdId} createdLotCount=${result.value.length} replayed=${result.replayed}`,
    );

    return result.value.map((lot) => InventoryLotMapper.toResponse(lot));
  }

  @Get('shopping-lists')
  @ApiOperation({ summary: 'Listar listas de compra guardadas' })
  async listShoppingLists(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Req() request: FastifyRequest,
  ): Promise<ShoppingListResponseDto[]> {
    const requestId = getRequestId(request) ?? 'none';
    this.logger.log(
      `shopping_list_list_requested requestId=${requestId} userId=${currentUser.userId}`,
    );
    const access = await this.resolveHouseholdPantryAccessUseCase.executeRead(
      currentUser.userId,
    );
    const lists = await this.listShoppingListsUseCase.execute(
      access.pantryOwnerUserId,
    );
    this.logger.log(
      `shopping_list_list_completed requestId=${requestId} userId=${currentUser.userId} pantryOwnerUserId=${access.pantryOwnerUserId} householdId=${access.householdId} listCount=${lists.length}`,
    );

    return lists.map((list) => this.toShoppingListResponse(list));
  }

  @Post('shopping-lists')
  @ApiOperation({ summary: 'Guardar lista de compra en la cuenta' })
  async createShoppingList(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: CreateShoppingListDto,
    @Req() request: FastifyRequest,
  ): Promise<ShoppingListResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const requestId = getRequestId(request) ?? 'none';
    this.logger.log(
      `shopping_list_create_requested requestId=${requestId} userId=${currentUser.userId} itemCount=${dto.items.length}`,
    );
    const access = await this.resolveHouseholdPantryAccessUseCase.executeWrite(
      currentUser.userId,
    );
    const list = await this.createShoppingListUseCase.execute({
      ownerUserId: access.pantryOwnerUserId,
      title: dto.title,
      occasion: dto.occasion,
      shoppingLocation: dto.shoppingLocation,
      items: dto.items,
    });
    await this.recordHouseholdActivityUseCase.execute({
      householdId: access.householdId,
      type: 'shopping_list_saved',
      actorUserId: currentUser.userId,
      targetLabel: list.toPrimitives().title,
    });
    this.logger.log(
      `shopping_list_create_completed requestId=${requestId} userId=${currentUser.userId} pantryOwnerUserId=${access.pantryOwnerUserId} householdId=${access.householdId} listId=${list.id}`,
    );

    return this.toShoppingListResponse(list);
  }

  @Delete('shopping-lists/:listId')
  @ApiOperation({ summary: 'Eliminar lista de compra guardada' })
  async deleteShoppingList(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('listId') listId: string,
    @Req() request: FastifyRequest,
  ): Promise<ShoppingListResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const requestId = getRequestId(request) ?? 'none';
    this.logger.log(
      `shopping_list_delete_requested requestId=${requestId} userId=${currentUser.userId} listId=${listId}`,
    );
    const access = await this.resolveHouseholdPantryAccessUseCase.executeWrite(
      currentUser.userId,
    );
    const list = await this.deleteShoppingListUseCase.execute({
      ownerUserId: access.pantryOwnerUserId,
      listId,
    });
    await this.recordHouseholdActivityUseCase.execute({
      householdId: access.householdId,
      type: 'shopping_list_deleted',
      actorUserId: currentUser.userId,
      targetLabel: list.toPrimitives().title,
    });
    this.logger.log(
      `shopping_list_delete_completed requestId=${requestId} userId=${currentUser.userId} pantryOwnerUserId=${access.pantryOwnerUserId} householdId=${access.householdId} listId=${listId}`,
    );

    return this.toShoppingListResponse(list);
  }

  @Post('shopping-shares')
  @ApiOperation({ summary: 'Crear enlace temporal de lista de compra' })
  async createShoppingShare(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: CreateShoppingShareDto,
    @Req() request: FastifyRequest,
  ): Promise<ShoppingShareResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const requestId = getRequestId(request) ?? 'none';
    this.logger.log(
      `shopping_share_create_requested requestId=${requestId} userId=${currentUser.userId} textLength=${dto.text.length}`,
    );
    const access = await this.resolveHouseholdPantryAccessUseCase.executeWrite(
      currentUser.userId,
    );

    const result = await this.createShoppingShareUseCase.execute({
      ownerUserId: access.pantryOwnerUserId,
      text: dto.text,
    });
    await this.recordHouseholdActivityUseCase.execute({
      householdId: access.householdId,
      type: 'shopping_share_created',
      actorUserId: currentUser.userId,
    });
    const response = this.toShoppingShareResponse(result.share, result.token);
    this.logger.log(
      `shopping_share_create_completed requestId=${requestId} userId=${currentUser.userId} pantryOwnerUserId=${access.pantryOwnerUserId} householdId=${access.householdId}`,
    );

    return response;
  }

  @Get('shopping-shares')
  @ApiOperation({ summary: 'Listar enlaces temporales activos' })
  async listActiveShoppingShares(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Req() request: FastifyRequest,
  ): Promise<ShoppingShareResponseDto[]> {
    const requestId = getRequestId(request) ?? 'none';
    this.logger.log(
      `shopping_share_list_requested requestId=${requestId} userId=${currentUser.userId}`,
    );
    const access = await this.resolveHouseholdPantryAccessUseCase.executeRead(
      currentUser.userId,
    );
    const shares = await this.listActiveShoppingSharesUseCase.execute(
      access.pantryOwnerUserId,
    );
    this.logger.log(
      `shopping_share_list_completed requestId=${requestId} userId=${currentUser.userId} pantryOwnerUserId=${access.pantryOwnerUserId} householdId=${access.householdId} activeCount=${shares.length}`,
    );

    return shares.map((share) => this.toShoppingShareResponse(share));
  }

  @Delete('shopping-shares/by-id/:shareId')
  @ApiOperation({ summary: 'Revocar enlace temporal por id interno' })
  async revokeShoppingShareById(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('shareId') shareId: string,
    @Req() request: FastifyRequest,
  ): Promise<ShoppingShareResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const requestId = getRequestId(request) ?? 'none';
    this.logger.log(
      `shopping_share_revoke_by_id_requested requestId=${requestId} userId=${currentUser.userId} shareId=${shareId}`,
    );
    const access = await this.resolveHouseholdPantryAccessUseCase.executeWrite(
      currentUser.userId,
    );

    try {
      const share = await this.revokeShoppingShareByIdUseCase.execute({
        ownerUserId: access.pantryOwnerUserId,
        shareId,
      });
      await this.recordHouseholdActivityUseCase.execute({
        householdId: access.householdId,
        type: 'shopping_share_revoked',
        actorUserId: currentUser.userId,
      });
      this.logger.log(
        `shopping_share_revoke_by_id_completed requestId=${requestId} userId=${currentUser.userId} pantryOwnerUserId=${access.pantryOwnerUserId} householdId=${access.householdId} shareId=${shareId}`,
      );

      return this.toShoppingShareResponse(share);
    } catch (error) {
      throw mapShoppingShareMutationError(error);
    }
  }

  @Delete('shopping-shares/:token')
  @ApiOperation({ summary: 'Revocar enlace temporal de lista de compra' })
  async revokeShoppingShare(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('token') token: string,
    @Req() request: FastifyRequest,
  ): Promise<ShoppingShareResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const requestId = getRequestId(request) ?? 'none';
    this.logger.log(
      `shopping_share_revoke_requested requestId=${requestId} userId=${currentUser.userId}`,
    );
    const access = await this.resolveHouseholdPantryAccessUseCase.executeWrite(
      currentUser.userId,
    );

    try {
      const share = await this.revokeShoppingShareUseCase.execute({
        ownerUserId: access.pantryOwnerUserId,
        token,
      });
      await this.recordHouseholdActivityUseCase.execute({
        householdId: access.householdId,
        type: 'shopping_share_revoked',
        actorUserId: currentUser.userId,
      });
      this.logger.log(
        `shopping_share_revoke_completed requestId=${requestId} userId=${currentUser.userId} pantryOwnerUserId=${access.pantryOwnerUserId} householdId=${access.householdId}`,
      );

      return this.toShoppingShareResponse(share);
    } catch (error) {
      throw mapShoppingShareMutationError(error);
    }
  }

  private toArchivedResponse(
    archivedItems: ArchivedPantryItems,
  ): ArchivedPantryItemsResponseDto {
    return {
      productTypes: archivedItems.productTypes.map((productType) =>
        ProductTypeMapper.toResponse(ProductType.fromPrimitives(productType)),
      ),
      inventoryLots: archivedItems.inventoryLots.map((lot) =>
        InventoryLotMapper.toResponse(InventoryLot.fromPrimitives(lot)),
      ),
      pagination: archivedItems.pagination,
    };
  }

  private async getPaginatedArchivedItems(
    pantryOwnerUserId: string,
    query: ArchivedPantryQueryDto,
  ): Promise<ArchivedPantryItems> {
    try {
      return await this.getArchivedPantryItemsUseCase.execute(
        pantryOwnerUserId,
        {
          limit: query.limit,
          productTypesCursor: query.productTypesCursor,
          inventoryLotsCursor: query.inventoryLotsCursor,
          includeProductTypes: query.includeProductTypes,
          includeInventoryLots: query.includeInventoryLots,
        },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.toLocaleLowerCase('en').includes('cursor')
      ) {
        throw new BadRequestException('Invalid archived pantry cursor');
      }

      throw error;
    }
  }

  private getPantryDataLimits(): PantryDataLimitsResponseDto {
    return {
      activeProductTypesPerUser: MAX_ACTIVE_PRODUCT_TYPES_PER_USER,
      archivedProductTypesPerUser: MAX_ARCHIVED_PRODUCT_TYPES_PER_USER,
      productTypeSearchResults: MAX_PRODUCT_TYPE_SEARCH_RESULTS,
      activeInventoryLotsPerUser: MAX_ACTIVE_INVENTORY_LOTS_PER_USER,
      archivedInventoryLotsPerUser: MAX_ARCHIVED_INVENTORY_LOTS_PER_USER,
      archivedPantryPageSize: MAX_ARCHIVED_PANTRY_PAGE_SIZE,
      inventoryLotsPerProductType: MAX_INVENTORY_LOTS_PER_PRODUCT_TYPE,
      shoppingCheckoutItems: MAX_SHOPPING_CHECKOUT_ITEMS,
      savedShoppingListsPerUser: MAX_SAVED_SHOPPING_LISTS_PER_USER,
      savedShoppingListItems: MAX_SAVED_SHOPPING_LIST_ITEMS,
    };
  }

  private toShoppingListResponse(list: ShoppingList): ShoppingListResponseDto {
    const primitives = list.toPrimitives();

    return {
      id: primitives.id,
      ownerUserId: primitives.ownerUserId,
      title: primitives.title,
      occasion: primitives.occasion,
      shoppingLocation: primitives.shoppingLocation,
      items: primitives.items,
      createdAt: primitives.createdAt,
      updatedAt: primitives.updatedAt,
    };
  }

  private toShoppingShareResponse(
    share: {
      toPrimitives: () => {
        id: string;
        createdAt: Date;
        expiresAt: Date;
        revokedAt?: Date;
      };
    },
    token?: string,
  ): ShoppingShareResponseDto {
    const primitives = share.toPrimitives();

    return {
      id: primitives.id,
      token,
      createdAt: primitives.createdAt,
      expiresAt: primitives.expiresAt,
      revokedAt: primitives.revokedAt,
    };
  }
}

function mapShoppingShareMutationError(error: unknown): Error {
  if (error instanceof ShoppingShareNotFoundError) {
    return new NotFoundException('Shopping share not found');
  }

  if (error instanceof Error && /not owned/i.test(error.message)) {
    return new ForbiddenException(
      'Shopping share is not owned by current user',
    );
  }

  if (error instanceof Error && /expired|revoked/i.test(error.message)) {
    return new GoneException('Shopping share expired or revoked');
  }

  return error instanceof Error ? error : new Error('Shopping share failed');
}
