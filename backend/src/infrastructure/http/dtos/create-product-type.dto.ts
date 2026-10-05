import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { QuantityUnit } from '../../../domain/enums';
import { ProductTypeShoppingMetadataDto } from './product-type-shopping-metadata.dto';

const quantityUnitValues = Object.values(QuantityUnit);

export class ProductTypeDepletionRuleDto {
  @ApiProperty()
  @IsBoolean()
  enabled: boolean;

  @ApiProperty({ example: 1 })
  @IsNumber()
  @Min(0.01)
  consumeAmount: number;

  @ApiProperty({ enum: quantityUnitValues })
  @IsString()
  @IsEnum(QuantityUnit)
  unit: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  everyAmount: number;

  @ApiProperty({ enum: ['day', 'week', 'month'] })
  @IsString()
  @IsEnum(['day', 'week', 'month'])
  everyPeriod: string;

  @ApiProperty({ example: '2026-04-24' })
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  anchorDate: string;
}

export class CreateProductTypeDto {
  @ApiProperty({ example: 'Atun' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  baseName: string;

  @ApiProperty({ enum: ['food', 'cleaning', 'hygiene', 'other'] })
  @IsString()
  @IsEnum(['food', 'cleaning', 'hygiene', 'other'])
  category: string;

  @ApiProperty({ enum: quantityUnitValues })
  @IsString()
  @IsEnum(QuantityUnit)
  defaultUnit: string;

  @ApiProperty({ required: false, type: ProductTypeDepletionRuleDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProductTypeDepletionRuleDto)
  defaultDepletionRule?: ProductTypeDepletionRuleDto;

  @ApiProperty({ required: false, type: ProductTypeShoppingMetadataDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProductTypeShoppingMetadataDto)
  shoppingMetadata?: ProductTypeShoppingMetadataDto;
}

export class UpdateProductTypeDepletionRuleDto {
  @ApiProperty({ type: ProductTypeDepletionRuleDto })
  @ValidateNested()
  @Type(() => ProductTypeDepletionRuleDto)
  defaultDepletionRule: ProductTypeDepletionRuleDto;
}
