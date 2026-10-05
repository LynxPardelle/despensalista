import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { QuantityUnit } from '../../../domain/enums';

export class CreateInventoryLotDto {
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
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expiresAt?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  purchaseDate?: string;
}
