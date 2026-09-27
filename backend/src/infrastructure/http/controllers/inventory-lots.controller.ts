import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FastifyReply, FastifyRequest } from 'fastify';
import { ArchiveInventoryLotUseCase } from '../../../application/use-cases/archive-inventory-lot.use-case';
import { ConsumeInventoryLotUseCase } from '../../../application/use-cases/consume-inventory-lot.use-case';
import { CreateInventoryLotUseCase } from '../../../application/use-cases/create-inventory-lot.use-case';
import { DeleteInventoryLotUseCase } from '../../../application/use-cases/delete-inventory-lot.use-case';
import { GetExpiringLotsUseCase } from '../../../application/use-cases/get-expiring-lots.use-case';
import { ResolveHouseholdPantryAccessUseCase } from '../../../application/use-cases/household.use-cases';
import { ListInventoryLotsUseCase } from '../../../application/use-cases/list-inventory-lots.use-case';
import { RestoreInventoryLotUseCase } from '../../../application/use-cases/restore-inventory-lot.use-case';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { AuthCookieService } from '../auth/auth-cookie.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { ArchivePantryItemDto } from '../dtos/archive-pantry-item.dto';
import { ConsumeInventoryLotDto } from '../dtos/consume-inventory-lot.dto';
import { CreateInventoryLotDto } from '../dtos/create-inventory-lot.dto';
import { DeletePantryItemDto } from '../dtos/delete-pantry-item.dto';
import { ExpiringProductGroupResponseDto } from '../dtos/pantry-overview-response.dto';
import { InventoryLotResponseDto } from '../dtos/inventory-lot-response.dto';
import { InventoryLotMapper } from '../mappers/inventory-lot.mapper';
import { PantryOverviewMapper } from '../mappers/pantry-overview.mapper';
import { CollectionPageQueryDto } from '../dtos/collection-page-query.dto';

@Controller('inventory-lots')
@ApiTags('inventory-lots')
@UseGuards(AccessTokenGuard)
export class InventoryLotsController {
  constructor(
    private readonly createInventoryLotUseCase: CreateInventoryLotUseCase,
    private readonly listInventoryLotsUseCase: ListInventoryLotsUseCase,
    private readonly getExpiringLotsUseCase: GetExpiringLotsUseCase,
    private readonly consumeInventoryLotUseCase: ConsumeInventoryLotUseCase,
    private readonly archiveInventoryLotUseCase: ArchiveInventoryLotUseCase,
    private readonly restoreInventoryLotUseCase: RestoreInventoryLotUseCase,
    private readonly deleteInventoryLotUseCase: DeleteInventoryLotUseCase,
    private readonly resolveHouseholdPantryAccessUseCase: ResolveHouseholdPantryAccessUseCase,
    private readonly authCookieService: AuthCookieService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Registrar un lote de inventario' })
  async create(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() createInventoryLotDto: CreateInventoryLotDto,
    @Req() request: FastifyRequest,
  ): Promise<InventoryLotResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const access = await this.resolveHouseholdPantryAccessUseCase.executeWrite(
      currentUser.userId,
    );

    const inventoryLot = await this.createInventoryLotUseCase.execute({
      userId: access.pantryOwnerUserId,
      productTypeId: createInventoryLotDto.productTypeId,
      variantName: createInventoryLotDto.variantName,
      quantity: createInventoryLotDto.quantity,
      unit: createInventoryLotDto.unit,
      expiresAt: createInventoryLotDto.expiresAt
        ? new Date(createInventoryLotDto.expiresAt)
        : undefined,
      purchaseDate: createInventoryLotDto.purchaseDate
        ? new Date(createInventoryLotDto.purchaseDate)
        : undefined,
    });

    return InventoryLotMapper.toResponse(inventoryLot);
  }

  @Get()
  @ApiOperation({ summary: 'Listar lotes del usuario' })
  async list(
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<InventoryLotResponseDto[]> {
    const access = await this.resolveHouseholdPantryAccessUseCase.executeRead(
      currentUser.userId,
    );
    const lots = await this.listInventoryLotsUseCase.execute(
      access.pantryOwnerUserId,
    );
    return lots.map((lot) => InventoryLotMapper.toResponse(lot));
  }

  @Get('page')
  async page(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query() query: CollectionPageQueryDto,
  ) {
    const access = await this.resolveHouseholdPantryAccessUseCase.executeRead(
      currentUser.userId,
    );
    const result = await this.listInventoryLotsUseCase.page(
      access.pantryOwnerUserId,
      query,
      query.productTypeId,
    );
    return {
      ...result,
      items: result.items.map((item) => InventoryLotMapper.toResponse(item)),
    };
  }

  @Get('expiring')
  @ApiOperation({
    summary: 'Listar lotes próximos a caducar agrupados por tipo base',
  })
  async expiring(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query('days', new DefaultValuePipe(7), ParseIntPipe) days: number,
  ): Promise<ExpiringProductGroupResponseDto[]> {
    if (days < 1) {
      throw new BadRequestException('days must be greater than zero');
    }

    const access = await this.resolveHouseholdPantryAccessUseCase.executeRead(
      currentUser.userId,
    );
    const groups = await this.getExpiringLotsUseCase.execute(
      access.pantryOwnerUserId,
      days,
    );

    return groups.map((group) =>
      PantryOverviewMapper.toExpiringGroupResponse(group),
    );
  }

  @Post(':id/consume')
  @ApiOperation({ summary: 'Consumir cantidad desde un lote específico' })
  async consume(
    @Param('id') id: string,
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() consumeInventoryLotDto: ConsumeInventoryLotDto,
    @Req() request: FastifyRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<InventoryLotResponseDto | null> {
    this.authCookieService.ensureXsrfForRequest(request);
    const access = await this.resolveHouseholdPantryAccessUseCase.executeWrite(
      currentUser.userId,
    );

    const result = await this.consumeInventoryLotUseCase.execute({
      lotId: id,
      userId: access.pantryOwnerUserId,
      quantity: consumeInventoryLotDto.quantity,
      wasteReason: consumeInventoryLotDto.wasteReason,
      wasteNote: consumeInventoryLotDto.wasteNote,
      idempotencyKey,
    });
    reply.header('Idempotency-Key', idempotencyKey ?? '');
    if (result.replayed) {
      reply.header('Idempotency-Replayed', 'true');
    }

    return result.value ? InventoryLotMapper.toResponse(result.value) : null;
  }

  @Post(':id/archive')
  @ApiOperation({ summary: 'Archivar un lote de inventario' })
  async archive(
    @Param('id') id: string,
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: ArchivePantryItemDto,
    @Req() request: FastifyRequest,
  ): Promise<InventoryLotResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const access = await this.resolveHouseholdPantryAccessUseCase.executeWrite(
      currentUser.userId,
    );

    const inventoryLot = await this.archiveInventoryLotUseCase.execute({
      lotId: id,
      userId: access.pantryOwnerUserId,
      reason: dto.reason,
    });

    return InventoryLotMapper.toResponse(inventoryLot);
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Restaurar un lote archivado' })
  async restore(
    @Param('id') id: string,
    @CurrentUser() currentUser: AuthenticatedUser,
    @Req() request: FastifyRequest,
  ): Promise<InventoryLotResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const access = await this.resolveHouseholdPantryAccessUseCase.executeWrite(
      currentUser.userId,
    );

    const inventoryLot = await this.restoreInventoryLotUseCase.execute({
      lotId: id,
      userId: access.pantryOwnerUserId,
    });

    return InventoryLotMapper.toResponse(inventoryLot);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar permanentemente un lote archivado' })
  async delete(
    @Param('id') id: string,
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: DeletePantryItemDto,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    this.authCookieService.ensureXsrfForRequest(request);
    const access = await this.resolveHouseholdPantryAccessUseCase.executeWrite(
      currentUser.userId,
    );

    return this.deleteInventoryLotUseCase.execute({
      lotId: id,
      userId: access.pantryOwnerUserId,
      confirmationText: dto.confirmationText,
    });
  }
}
