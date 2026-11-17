import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';
import {
  AcceptHouseholdInviteUseCase,
  CreateHouseholdInviteUseCase,
  GetHouseholdWorkspaceUseCase,
  RemoveHouseholdMemberUseCase,
  RevokeHouseholdInviteUseCase,
} from '../../../application/use-cases/household.use-cases';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { AuthCookieService } from '../auth/auth-cookie.service';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AcceptHouseholdInviteDto,
  CreateHouseholdInviteDto,
  CreateHouseholdInviteResponseDto,
  HouseholdInviteResponseDto,
  HouseholdWorkspaceResponseDto,
} from '../dtos/household.dto';
import { HouseholdMapper } from '../mappers/household.mapper';
import { getRequestId } from '../request-id';

@Controller('household')
@ApiTags('household')
@UseGuards(AccessTokenGuard)
export class HouseholdController {
  private readonly logger = new Logger(HouseholdController.name);

  constructor(
    private readonly getHouseholdWorkspaceUseCase: GetHouseholdWorkspaceUseCase,
    private readonly createHouseholdInviteUseCase: CreateHouseholdInviteUseCase,
    private readonly acceptHouseholdInviteUseCase: AcceptHouseholdInviteUseCase,
    private readonly revokeHouseholdInviteUseCase: RevokeHouseholdInviteUseCase,
    private readonly removeHouseholdMemberUseCase: RemoveHouseholdMemberUseCase,
    private readonly authCookieService: AuthCookieService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Obtener espacio de hogar del usuario' })
  async getWorkspace(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Req() request: FastifyRequest,
  ): Promise<HouseholdWorkspaceResponseDto> {
    const requestId = getRequestId(request) ?? 'none';
    this.logger.log(
      `household_workspace_requested requestId=${requestId} userId=${currentUser.userId}`,
    );
    const workspace = await this.getHouseholdWorkspaceUseCase.execute(
      currentUser.userId,
    );
    this.logger.log(
      `household_workspace_completed requestId=${requestId} userId=${currentUser.userId} memberCount=${workspace.members.length} inviteCount=${workspace.invites.length}`,
    );

    return HouseholdMapper.toWorkspaceResponse(workspace);
  }

  @Post('invites')
  @ApiOperation({ summary: 'Crear invitacion de hogar' })
  async createInvite(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: CreateHouseholdInviteDto,
    @Req() request: FastifyRequest,
  ): Promise<CreateHouseholdInviteResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const requestId = getRequestId(request) ?? 'none';
    this.logger.log(
      `household_invite_create_requested requestId=${requestId} userId=${currentUser.userId} role=${dto.role}`,
    );
    const result = await this.createHouseholdInviteUseCase.execute({
      requesterUserId: currentUser.userId,
      email: dto.email,
      role: dto.role,
    });
    this.logger.log(
      `household_invite_create_completed requestId=${requestId} userId=${currentUser.userId} inviteId=${result.invite.id}`,
    );

    return {
      invite: HouseholdMapper.toInviteResponse(result.invite.toPrimitives()),
      token: result.token,
    };
  }

  @Post('invites/accept')
  @ApiOperation({ summary: 'Aceptar invitacion de hogar' })
  async acceptInvite(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: AcceptHouseholdInviteDto,
    @Req() request: FastifyRequest,
  ): Promise<HouseholdWorkspaceResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const requestId = getRequestId(request) ?? 'none';
    this.logger.log(
      `household_invite_accept_requested requestId=${requestId} userId=${currentUser.userId} tokenLength=${dto.token.length}`,
    );
    const workspace = await this.acceptHouseholdInviteUseCase.execute({
      userId: currentUser.userId,
      token: dto.token,
      switchFromHouseholdId: dto.switchFromHouseholdId,
    });
    this.logger.log(
      `household_invite_accept_completed requestId=${requestId} userId=${currentUser.userId} householdId=${workspace.household.id}`,
    );

    return HouseholdMapper.toWorkspaceResponse(workspace);
  }

  @Delete('invites/:inviteId')
  @ApiOperation({ summary: 'Revocar invitacion de hogar' })
  async revokeInvite(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('inviteId') inviteId: string,
    @Req() request: FastifyRequest,
  ): Promise<HouseholdInviteResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const requestId = getRequestId(request) ?? 'none';
    this.logger.log(
      `household_invite_revoke_requested requestId=${requestId} userId=${currentUser.userId} inviteId=${inviteId}`,
    );
    const invite = await this.revokeHouseholdInviteUseCase.execute({
      requesterUserId: currentUser.userId,
      inviteId,
    });
    this.logger.log(
      `household_invite_revoke_completed requestId=${requestId} userId=${currentUser.userId} inviteId=${inviteId}`,
    );

    return HouseholdMapper.toInviteResponse(invite.toPrimitives());
  }

  @Delete('members/:memberUserId')
  @ApiOperation({ summary: 'Quitar miembro del hogar' })
  async removeMember(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('memberUserId') memberUserId: string,
    @Req() request: FastifyRequest,
  ): Promise<HouseholdWorkspaceResponseDto> {
    this.authCookieService.ensureXsrfForRequest(request);
    const requestId = getRequestId(request) ?? 'none';
    this.logger.log(
      `household_member_remove_requested requestId=${requestId} userId=${currentUser.userId} memberUserId=${memberUserId}`,
    );
    await this.removeHouseholdMemberUseCase.execute({
      requesterUserId: currentUser.userId,
      memberUserId,
    });
    const workspace = await this.getHouseholdWorkspaceUseCase.execute(
      currentUser.userId,
    );
    this.logger.log(
      `household_member_remove_completed requestId=${requestId} userId=${currentUser.userId} memberUserId=${memberUserId}`,
    );

    return HouseholdMapper.toWorkspaceResponse(workspace);
  }
}
