import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { USER_DAO } from '../../application/tokens';
import type { UserDao } from '../../application/ports/daos';
import {
  ResolveHouseholdPantryAccessUseCase,
  type HouseholdPantryAccess,
} from '../../application/use-cases/household.use-cases';
import { HouseholdOriginMismatchError } from '../../application/ports/pantry-mutation.port';
import { UserId } from '../../domain/value-objects/user-id.vo';
import {
  StripeBillingStore,
  type BillingRecord,
} from '../billing/stripe-billing.store';
import { AccessCodeStore } from './access-code.store';
import { type AccessCodeRecord, type AccessGrant } from './access-code.types';

export class AccessCodeException extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status = 400,
  ) {
    super(message, status);
  }
}

function invalidCode(): AccessCodeException {
  return new AccessCodeException(
    'ACCESS_CODE_INVALID',
    'El código de acceso no es válido.',
  );
}

function actorHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex');
}

function billingBlocksCode(
  record: BillingRecord | undefined,
  now: Date,
): boolean {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (record?.closed) return true;
  if (record?.checkout && record.checkout.expiresAt > nowSeconds) return true;
  if (
    !record?.status ||
    record.status === 'canceled' ||
    record.status === 'incomplete_expired'
  )
    return false;
  return !(record.status === 'active' && record.cancelAtPeriodEnd === true);
}

function addCalendarMonths(start: Date, months: number): string {
  const end = new Date(start);
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0),
  ).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return end.toISOString();
}

@Injectable()
export class AccessCodeService {
  constructor(
    private readonly store: AccessCodeStore,
    private readonly access: ResolveHouseholdPantryAccessUseCase,
    @Inject(USER_DAO) private readonly users: UserDao,
    private readonly billing: StripeBillingStore,
    private readonly config: ConfigService,
  ) {}

  async status(userId: string) {
    return this.statusFor(await this.access.executeRead(userId));
  }

  async redeem(userId: string, token: string, householdId: string) {
    const match =
      /^DL1\.([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.([A-Za-z0-9_-]{43})$/.exec(
        token.trim(),
      );
    if (!match) throw invalidCode();
    const access = await this.access.executeOwner(userId);
    if (access.householdId !== householdId)
      throw new HouseholdOriginMismatchError();
    const now = new Date();
    if (!(await this.store.reserveAttempt(userId, now))) {
      throw new AccessCodeException(
        'ACCESS_CODE_RATE_LIMITED',
        'Se alcanzó el límite de intentos. Vuelve a intentarlo más tarde.',
        429,
      );
    }
    const id = match[1];
    const expectedDigest = createHash('sha256').update(token.trim()).digest();
    for (let retry = 0; retry < 5; retry++) {
      const code = await this.store.readCode(id);
      if (
        !code ||
        !/^[a-f0-9]{64}$/.test(code.secretHash) ||
        !timingSafeEqual(expectedDigest, Buffer.from(code.secretHash, 'hex'))
      ) {
        throw invalidCode();
      }
      if (code.state === 'revoked') {
        throw new AccessCodeException(
          'ACCESS_CODE_REVOKED',
          'Este código fue revocado.',
        );
      }
      if (code.state === 'redeemed') {
        if (
          code.redeemedByHash !== actorHash(userId) ||
          code.redeemedHouseholdId !== householdId
        ) {
          throw new AccessCodeException(
            'ACCESS_CODE_USED',
            'Este código ya fue utilizado.',
          );
        }
        return { ...(await this.statusFor(access)), replayed: true };
      }
      if (Date.parse(code.redeemUntil) <= now.getTime()) {
        throw new AccessCodeException(
          'ACCESS_CODE_EXPIRED',
          'El plazo para canjear este código terminó.',
        );
      }
      this.assertGrantDefinition(code);
      if (code.recipientEmail) {
        const user = await this.users.findById(UserId.fromString(userId));
        if (
          !user ||
          user.email.toLowerCase() !== code.recipientEmail.toLowerCase()
        )
          throw invalidCode();
      }
      const billingTable = this.config.get<string>('STRIPE_BILLING_TABLE');
      const record = billingTable
        ? await this.billing.read(billingTable, householdId)
        : undefined;
      if (billingBlocksCode(record, now)) {
        throw new AccessCodeException(
          'ACCESS_CODE_BILLING_ACTIVE',
          'Primero cancela la renovación desde el portal. Podrás canjear el código cuando la cancelación esté confirmada.',
          409,
        );
      }
      const snapshot = await this.store.readGrants(householdId);
      const start =
        !code.lifetime && record?.cancelAtPeriodEnd && record.paidThrough
          ? new Date(Math.max(now.getTime(), record.paidThrough * 1000))
          : now;
      const grant: AccessGrant = {
        id: code.id,
        plan: code.plan,
        mode: code.mode,
        lifetime: code.lifetime,
        startsAt: start.toISOString(),
        expiresAt: code.lifetime
          ? null
          : addCalendarMonths(start, code.months!),
      };
      if (
        await this.store.commitRedemption({
          code,
          grant,
          expectedRevision: snapshot.revision,
          userId,
          householdId,
          joinedAt: access.joinedAt.toISOString(),
          contextVersion: access.contextVersion,
          billingTable,
          billingRevision: record?.revision ?? 0,
          redeemedByHash: actorHash(userId),
        })
      ) {
        return { ...(await this.statusFor(access)), replayed: false };
      }
      // An identical request can win while this one waits for the transaction.
      if (retry < 4)
        await new Promise((resolve) => setTimeout(resolve, 25 * (retry + 1)));
    }
    throw new ConflictException(
      'El hogar cambió durante el canje. Recarga el perfil y vuelve a intentarlo.',
    );
  }

  private async statusFor(access: HouseholdPantryAccess) {
    const table = this.config.get<string>('STRIPE_BILLING_TABLE');
    const [snapshot, record] = await Promise.all([
      this.store.readGrants(access.householdId),
      table ? this.billing.read(table, access.householdId) : undefined,
    ]);
    const now = new Date();
    const blocked = billingBlocksCode(record, now);
    return {
      householdId: access.householdId,
      canRedeem: access.role === 'owner' && !blocked,
      billingBlocksRedemption: blocked,
      grants: snapshot.grants
        .filter(
          (grant) =>
            grant.expiresAt === null ||
            Date.parse(grant.expiresAt) > now.getTime(),
        )
        .map(({ id, plan, mode, startsAt, expiresAt, lifetime }) => ({
          id,
          plan,
          mode,
          startsAt,
          expiresAt,
          lifetime,
        })),
    };
  }

  private assertGrantDefinition(code: AccessCodeRecord): void {
    if (
      !['plus', 'pro'].includes(code.plan) ||
      !['plan', 'developer'].includes(code.mode) ||
      !Number.isFinite(Date.parse(code.redeemUntil)) ||
      (!code.lifetime &&
        (!Number.isInteger(code.months) ||
          code.months! < 1 ||
          code.months! > 120)) ||
      (code.mode === 'developer' && !code.lifetime)
    ) {
      throw invalidCode();
    }
  }
}
