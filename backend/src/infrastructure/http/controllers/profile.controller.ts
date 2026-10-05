import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Patch,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FastifyReply, FastifyRequest } from 'fastify';
import { DeleteAccountUseCase } from '../../../application/use-cases/delete-account.use-case';
import { DeletePantryDataUseCase } from '../../../application/use-cases/delete-pantry-data.use-case';
import { GetUserProfileUseCase } from '../../../application/use-cases/get-user-profile.use-case';
import { ResolveHouseholdPantryAccessUseCase } from '../../../application/use-cases/household.use-cases';
import { SignOutAllSessionsUseCase } from '../../../application/use-cases/sign-out-all-sessions.use-case';
import { UpdateUserPreferencesUseCase } from '../../../application/use-cases/update-user-preferences.use-case';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { AuthCookieService } from '../auth/auth-cookie.service';
import { AuthStepUpService } from '../auth/auth-step-up.service';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  DeleteAccountDto,
  DeleteAccountResponseDto,
  DeletePantryDataDto,
  DeletePantryDataResponseDto,
  SignOutAllSessionsDto,
  SignOutAllSessionsResponseDto,
} from '../dtos/delete-pantry-data.dto';
import {
  UserPreferencesResponseDto,
  UserProfileResponseDto,
} from '../dtos/profile-response.dto';
import { UpdateUserPreferencesDto } from '../dtos/update-user-preferences.dto';
import { ProfileMapper } from '../mappers/profile.mapper';

@Controller('profile')
@ApiTags('profile')
@UseGuards(AccessTokenGuard)
export class ProfileController {
  constructor(
    private readonly getUserProfileUseCase: GetUserProfileUseCase,
    private readonly updateUserPreferencesUseCase: UpdateUserPreferencesUseCase,
    private readonly deletePantryDataUseCase: DeletePantryDataUseCase,
    private readonly deleteAccountUseCase: DeleteAccountUseCase,
    private readonly signOutAllSessionsUseCase: SignOutAllSessionsUseCase,
    private readonly resolveHouseholdPantryAccessUseCase: ResolveHouseholdPantryAccessUseCase,
    private readonly authCookieService: AuthCookieService,
    private readonly authStepUpService: AuthStepUpService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Obtener perfil y preferencias del usuario' })
  async getProfile(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Req() request: FastifyRequest,
  ): Promise<UserProfileResponseDto> {
    const profile = await this.getUserProfileUseCase.execute(
      currentUser.userId,
      {
        clientDeviceId: getFirstHeader(request.headers['x-client-device-id']),
        userAgent: getFirstHeader(request.headers['user-agent']),
      },
    );

    return ProfileMapper.toProfileResponse(profile, {
      stepUp: this.authStepUpService.getStatus(currentUser),
    });
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Actualizar preferencias de Despensa Lista' })
  async updatePreferences(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: UpdateUserPreferencesDto,
    @Req() request: FastifyRequest,
  ): Promise<UserPreferencesResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const preferences = await this.updateUserPreferencesUseCase.execute(
      currentUser.userId,
      dto,
    );

    return ProfileMapper.toPreferencesResponse(preferences);
  }

  @Delete('pantry-data')
  @ApiOperation({ summary: 'Eliminar datos locales de despensa del usuario' })
  @ApiHeader({
    name: 'Idempotency-Key',
    description: 'UUID estable para reintentos del mismo borrado',
    required: true,
  })
  async deletePantryData(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: DeletePantryDataDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: FastifyRequest,
  ): Promise<DeletePantryDataResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    this.authStepUpService.assertFreshAuthentication(
      currentUser,
      'Deleting pantry data',
    );
    const access = await this.resolveHouseholdPantryAccessUseCase.executeOwner(
      currentUser.userId,
    );

    return this.deletePantryDataUseCase.execute({
      userId: access.pantryOwnerUserId,
      confirmationText: dto.confirmationText,
      idempotencyKey,
    });
  }

  @Delete('account')
  @ApiOperation({
    summary: 'Eliminar cuenta Despensa Lista e identidad Cognito',
  })
  async deleteAccount(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: DeleteAccountDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DeleteAccountResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    this.authStepUpService.assertFreshAuthentication(
      currentUser,
      'Deleting account',
    );
    const result = await this.deleteAccountUseCase.execute({
      userId: currentUser.userId,
      confirmationText: dto.confirmationText,
    });
    this.authCookieService.clearSessionCookies(reply);

    return result;
  }

  @Delete('sessions')
  @ApiOperation({
    summary: 'Cerrar sesiones Cognito en todos los dispositivos',
  })
  async signOutAllSessions(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: SignOutAllSessionsDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SignOutAllSessionsResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    this.authStepUpService.assertFreshAuthentication(
      currentUser,
      'Signing out all sessions',
    );
    const result = await this.signOutAllSessionsUseCase.execute({
      userId: currentUser.userId,
      confirmationText: dto.confirmationText,
    });
    this.authCookieService.clearSessionCookies(reply);

    return {
      ...result,
      localSessionCleared: true,
    };
  }
}

function getFirstHeader(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
