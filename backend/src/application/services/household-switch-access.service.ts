import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HOUSEHOLD_REPOSITORY } from '../tokens';
import type { HouseholdRepository } from '../../domain/repositories/household.repository';

export const householdWriteOrigin = new AsyncLocalStorage<{
  householdId?: string;
  checkout: boolean;
}>();

@Injectable()
export class HouseholdSwitchAccessService {
  constructor(
    private readonly config: ConfigService,
    @Inject(HOUSEHOLD_REPOSITORY)
    private readonly households: HouseholdRepository,
  ) {}

  async registerNewAccount(userId: string): Promise<void> {
    if (this.enabled) {
      await this.households.registerHouseholdSwitchCandidate(userId);
    }
  }

  async prepareAuthenticatedWrite(
    userId: string,
    method: string,
    url: string,
  ): Promise<void> {
    if (/^(GET|HEAD|OPTIONS)$/.test(method)) return;
    const path = url.split('?', 1)[0].replace(/\/$/, '');
    const prefix = `/${this.config.get<string>('API_PREFIX') ?? 'api'}`;
    const route = path.startsWith(`${prefix}/`)
      ? path.slice(prefix.length)
      : path;
    if (
      route === '/household/invites/accept' ||
      /^\/(?:auth|mfa\/google|feedback)(?:\/|$)/.test(route)
    ) {
      return;
    }
    await this.households.markHouseholdUsed(userId);
  }

  private get enabled(): boolean {
    return this.config.get<string>('HOUSEHOLD_SWITCH_ENABLED') === 'true';
  }
}
