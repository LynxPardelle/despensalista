import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { AuthCookieService } from '../auth/auth-cookie.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { ArchivePantryItemDto } from '../dtos/archive-pantry-item.dto';
import {
  CreateProductTypeDto,
  UpdateProductTypeDepletionRuleDto,
} from '../dtos/create-product-type.dto';
import { DeletePantryItemDto } from '../dtos/delete-pantry-item.dto';
import { ProductTypeResponseDto } from '../dtos/product-type-response.dto';
import { UpdateProductTypePlanningSettingsDto } from '../dtos/update-product-type-planning-settings.dto';
import { UpdateProductTypeShoppingMetadataDto } from '../dtos/update-product-type-shopping-metadata.dto';
import { ProductTypeMapper } from '../mappers/product-type.mapper';
import { CollectionPageQueryDto } from '../dtos/collection-page-query.dto';

@Controller('product-types')
@ApiTags('product-types')
@UseGuards(AccessTokenGuard)
export class ProductTypesController {
  constructor(
    private readonly createProductTypeUseCase: CreateProductTypeUseCase,
    private readonly getProductTypeByIdUseCase: GetProductTypeByIdUseCase,
    private readonly searchProductTypesUseCase: SearchProductTypesUseCase,
    private readonly updateProductTypeDepletionRuleUseCase: UpdateProductTypeDepletionRuleUseCase,
    private readonly updateProductTypePlanningSettingsUseCase: UpdateProductTypePlanningSettingsUseCase,
    private readonly updateProductTypeShoppingMetadataUseCase: UpdateProductTypeShoppingMetadataUseCase,
    private readonly archiveProductTypeUseCase: ArchiveProductTypeUseCase,
    private readonly restoreProductTypeUseCase: RestoreProductTypeUseCase,
    private readonly deleteProductTypeUseCase: DeleteProductTypeUseCase,
    private readonly resolveHouseholdPantryAccessUseCase: ResolveHouseholdPantryAccessUseCase,
    private readonly authCookieService: AuthCookieService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Crear un tipo base de producto' })
  async create(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() createProductTypeDto: CreateProductTypeDto,
    @Req() request: FastifyRequest,
  ): Promise<ProductTypeResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const access = await this.resolveHouseholdPantryAccessUseCase.executeWrite(
      currentUser.userId,
    );

    const productType = await this.createProductTypeUseCase.execute({
      userId: access.pantryOwnerUserId,
      baseName: createProductTypeDto.baseName,
      category: createProductTypeDto.category,
      defaultUnit: createProductTypeDto.defaultUnit,
      defaultDepletionRule: createProductTypeDto.defaultDepletionRule,
      shoppingMetadata: createProductTypeDto.shoppingMetadata,
    });

    return ProductTypeMapper.toResponse(productType);
  }

  @Get()
  @ApiOperation({ summary: 'Buscar tipos base por usuario' })
  async search(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query('search') search?: string,
  ): Promise<ProductTypeResponseDto[]> {
    const access = await this.resolveHouseholdPantryAccessUseCase.executeRead(
      currentUser.userId,
    );
    const productTypes = await this.searchProductTypesUseCase.execute(
      access.pantryOwnerUserId,
      search,
    );

    return productTypes.map((productType) =>
      ProductTypeMapper.toResponse(productType),
    );
  }

  @Get('page')
  async page(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query() query: CollectionPageQueryDto,
  ) {
    const access = await this.resolveHouseholdPantryAccessUseCase.executeRead(
      currentUser.userId,
    );
    const result = await this.searchProductTypesUseCase.page(
      access.pantryOwnerUserId,
      query,
      query.search,
    );
    return {
      ...result,
      items: result.items.map((item) => ProductTypeMapper.toResponse(item)),
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener tipo base por identificador' })
  async findOne(
    @Param('id') id: string,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<ProductTypeResponseDto> {
    const access = await this.resolveHouseholdPantryAccessUseCase.executeRead(
      currentUser.userId,
    );
    const productType = await this.getProductTypeByIdUseCase.execute(
      id,
      access.pantryOwnerUserId,
    );
    return ProductTypeMapper.toResponse(productType);
  }

  @Patch(':id/depletion-rule')
  @ApiOperation({ summary: 'Actualizar durabilidad de un tipo base' })
  async updateDepletionRule(
    @Param('id') id: string,
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: UpdateProductTypeDepletionRuleDto,
    @Req() request: FastifyRequest,
  ): Promise<ProductTypeResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const access = await this.resolveHouseholdPantryAccessUseCase.executeWrite(
      currentUser.userId,
    );

    const productType =
      await this.updateProductTypeDepletionRuleUseCase.execute({
        productTypeId: id,
        userId: access.pantryOwnerUserId,
        defaultDepletionRule: dto.defaultDepletionRule,
      });

    return ProductTypeMapper.toResponse(productType);
  }

  @Patch(':id/shopping-metadata')
  @ApiOperation({ summary: 'Actualizar datos de compra de un tipo base' })
  async updateShoppingMetadata(
    @Param('id') id: string,
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: UpdateProductTypeShoppingMetadataDto,
    @Req() request: FastifyRequest,
  ): Promise<ProductTypeResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const access = await this.resolveHouseholdPantryAccessUseCase.executeWrite(
      currentUser.userId,
    );

    const productType =
      await this.updateProductTypeShoppingMetadataUseCase.execute({
        productTypeId: id,
        userId: access.pantryOwnerUserId,
        shoppingMetadata: dto,
      });

    return ProductTypeMapper.toResponse(productType);
  }

  @Patch(':id/planning-settings')
  @ApiOperation({ summary: 'Actualizar reglas de planeación de un tipo base' })
  async updatePlanningSettings(
    @Param('id') id: string,
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: UpdateProductTypePlanningSettingsDto,
    @Req() request: FastifyRequest,
  ): Promise<ProductTypeResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const access = await this.resolveHouseholdPantryAccessUseCase.executeWrite(
      currentUser.userId,
    );

    const productType =
      await this.updateProductTypePlanningSettingsUseCase.execute({
        productTypeId: id,
        userId: access.pantryOwnerUserId,
        planningSettings: dto,
      });

    return ProductTypeMapper.toResponse(productType);
  }

  @Post(':id/archive')
  @ApiOperation({ summary: 'Archivar un tipo base' })
  async archive(
    @Param('id') id: string,
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: ArchivePantryItemDto,
    @Req() request: FastifyRequest,
  ): Promise<ProductTypeResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const access = await this.resolveHouseholdPantryAccessUseCase.executeWrite(
      currentUser.userId,
    );

    const productType = await this.archiveProductTypeUseCase.execute({
      productTypeId: id,
      userId: access.pantryOwnerUserId,
      reason: dto.reason,
    });

    return ProductTypeMapper.toResponse(productType);
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Restaurar un tipo base archivado' })
  async restore(
    @Param('id') id: string,
    @CurrentUser() currentUser: AuthenticatedUser,
    @Req() request: FastifyRequest,
  ): Promise<ProductTypeResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const access = await this.resolveHouseholdPantryAccessUseCase.executeWrite(
      currentUser.userId,
    );

    const productType = await this.restoreProductTypeUseCase.execute({
      productTypeId: id,
      userId: access.pantryOwnerUserId,
    });

    return ProductTypeMapper.toResponse(productType);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar permanentemente un tipo base archivado' })
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

    return this.deleteProductTypeUseCase.execute({
      productTypeId: id,
      userId: access.pantryOwnerUserId,
      confirmationText: dto.confirmationText,
    });
  }
}
