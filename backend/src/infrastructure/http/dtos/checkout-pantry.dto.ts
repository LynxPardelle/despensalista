import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { MAX_SHOPPING_CHECKOUT_ITEMS } from '../../../application/constants/query-limits';
import { QuantityUnit } from '../../../domain/enums';

export class CheckoutPantryItemDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  productTypeId: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  variantName?: string;

  @ApiProperty()
  @IsNumber()
  @IsPositive()
  quantity: number;

  @ApiProperty({ enum: Object.values(QuantityUnit) })
  @IsString()
  @IsEnum(QuantityUnit)
  unit: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Max(1000000)
  paidUnitPrice?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  shoppingLocation?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expiresAt?: string;
}

export class CheckoutPantryDto {
  @ApiProperty({ type: [CheckoutPantryItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SHOPPING_CHECKOUT_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => CheckoutPantryItemDto)
  items: CheckoutPantryItemDto[];
}
