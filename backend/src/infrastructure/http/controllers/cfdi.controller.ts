import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CfdiService } from '../../billing/cfdi/cfdi.service';
import { AccessTokenGuard } from '../auth/access-token.guard';
import type { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { CurrentUser } from '../auth/current-user.decorator';

@Controller('billing/invoices')
@UseGuards(AccessTokenGuard)
export class CfdiController {
  constructor(private readonly cfdi: CfdiService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  invoices(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor: unknown,
  ) {
    return this.cfdi.invoices(user.userId, cursor);
  }

  @Post(':id/cfdi-requests')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  request(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') invoiceId: string,
    @Body() body: unknown,
  ) {
    return this.cfdi.request(user.userId, invoiceId, body);
  }
}
