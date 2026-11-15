import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { GetPlusHouseholdSummaryUseCase } from '../../../application/use-cases/get-plus-household-summary.use-case';
import { ResolveHouseholdPantryAccessUseCase } from '../../../application/use-cases/household.use-cases';
import { AccessTokenGuard } from '../auth/access-token.guard';
import type { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { CurrentUser } from '../auth/current-user.decorator';

@Controller('pantry')
@UseGuards(AccessTokenGuard)
export class PlusHouseholdSummaryController {
  constructor(
    private readonly access: ResolveHouseholdPantryAccessUseCase,
    private readonly summary: GetPlusHouseholdSummaryUseCase,
  ) {}

  @Get('plus-summary')
  @Header('Cache-Control', 'private, no-store')
  async getSummary(@CurrentUser() user: AuthenticatedUser) {
    const { householdId, pantryOwnerUserId } = await this.access.executeRead(
      user.userId,
    );
    return this.summary.execute(householdId, pantryOwnerUserId);
  }
}
