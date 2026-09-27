import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class DeletePantryDataDto {
  @ApiProperty({ example: 'ELIMINAR' })
  @IsString()
  confirmationText: string;
}

export class DeletePantryDataResponseDto {
  @ApiProperty()
  deletedInventoryLotCount: number;

  @ApiProperty()
  deletedProductTypeCount: number;

  @ApiProperty()
  deletedShoppingListCount: number;

  @ApiProperty()
  deletedShoppingShareCount: number;

  @ApiProperty()
  deletedWasteEventCount: number;
}

export class DeleteAccountDto {
  @ApiProperty({ example: 'ELIMINAR CUENTA' })
  @IsString()
  confirmationText: string;
}

export class DeleteAccountResponseDto extends DeletePantryDataResponseDto {
  @ApiProperty()
  deletedKnownDeviceCount: number;

  @ApiProperty()
  deletedCognitoIdentityCount: number;
}

export class SignOutAllSessionsDto {
  @ApiProperty({ example: 'CERRAR SESIONES' })
  @IsString()
  confirmationText: string;
}

export class SignOutAllSessionsResponseDto {
  @ApiProperty()
  revokedCognitoSessionCount: number;

  @ApiProperty()
  localSessionCleared: boolean;
}
