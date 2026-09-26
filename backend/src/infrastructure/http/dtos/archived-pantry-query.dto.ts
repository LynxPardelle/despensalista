import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_ARCHIVED_PANTRY_PAGE_SIZE } from '../../../application/constants/query-limits';

export class ArchivedPantryQueryDto {
  @ApiPropertyOptional({
    description: 'Opaque cursor for archived product types',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  productTypesCursor?: string;

  @ApiPropertyOptional({
    description: 'Opaque cursor for archived inventory lots',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  inventoryLotsCursor?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_ARCHIVED_PANTRY_PAGE_SIZE,
    default: MAX_ARCHIVED_PANTRY_PAGE_SIZE,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_ARCHIVED_PANTRY_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Transform(({ value }) => transformBooleanQuery(value))
  @IsBoolean()
  includeProductTypes?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Transform(({ value }) => transformBooleanQuery(value))
  @IsBoolean()
  includeInventoryLots?: boolean;
}

function transformBooleanQuery(value: unknown): unknown {
  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return value;
}
