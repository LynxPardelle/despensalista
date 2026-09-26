import { createHash } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserDevice } from '../../domain/entities/user-device.entity';
import { UserDeviceRepository } from '../../domain/repositories/user-device.repository';
import { UserDao, UserPreferencesDao } from '../ports/daos';
import {
  USER_DAO,
  USER_DEVICE_REPOSITORY,
  USER_PREFERENCES_DAO,
} from '../tokens';
import { buildRetentionPolicy } from '../policies/retention-policy';
import {
  KnownUserDevice,
  UserProfile,
} from '../read-models/user-profile.read-model';
import { UserId } from '../../domain/value-objects/user-id.vo';

export interface UserProfileDeviceContext {
  clientDeviceId?: string;
  userAgent?: string;
}

const MAX_USER_DEVICES_PER_USER = 25;

@Injectable()
export class GetUserProfileUseCase {
  constructor(
    @Inject(USER_DAO)
    private readonly userDao: UserDao,
    @Inject(USER_PREFERENCES_DAO)
    private readonly preferencesDao: UserPreferencesDao,
    @Inject(USER_DEVICE_REPOSITORY)
    private readonly userDeviceRepository: UserDeviceRepository,
    private readonly configService: ConfigService,
  ) {}

  async execute(
    userId: string,
    deviceContext: UserProfileDeviceContext = {},
  ): Promise<UserProfile> {
    const normalizedUserId = UserId.fromString(userId);
    const user = await this.userDao.findById(normalizedUserId);

    if (!user) {
      throw new NotFoundException('User profile was not found');
    }

    const preferences =
      await this.preferencesDao.findByUserId(normalizedUserId);
    const currentDeviceId = await this.recordCurrentDevice(
      normalizedUserId,
      deviceContext,
    );
    const devices = await this.userDeviceRepository.findByUserId(
      normalizedUserId,
      10,
    );

    return {
      id: user.id.toString(),
      email: user.email,
      username: user.username,
      status: user.status,
      connectedIdentityCount: user.authSubjectIds.length,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      preferences: preferences.toPrimitives(),
      retentionPolicy: buildRetentionPolicy(this.configService),
      knownDevices: devices.map((device) =>
        this.toKnownDevice(device, currentDeviceId),
      ),
    };
  }

  private async recordCurrentDevice(
    userId: UserId,
    context: UserProfileDeviceContext,
  ): Promise<string | undefined> {
    const rawDeviceIdentity =
      normalizeOptionalText(context.clientDeviceId, 160) ??
      normalizeOptionalText(context.userAgent, 240);

    if (!rawDeviceIdentity) {
      return undefined;
    }

    const id = hashDeviceId(userId.toString(), rawDeviceIdentity);
    const userAgentSummary = summarizeUserAgent(context.userAgent);
    const label = buildDeviceLabel(userAgentSummary);
    const existingDevice = await this.userDeviceRepository.findById(id);

    if (existingDevice) {
      existingDevice.recordSeen({
        label,
        userAgentSummary,
      });
      await this.userDeviceRepository.save(existingDevice);
      return id;
    }

    const existingDevices = await this.userDeviceRepository.findByUserId(
      userId,
      MAX_USER_DEVICES_PER_USER,
    );

    if (existingDevices.length >= MAX_USER_DEVICES_PER_USER) {
      return undefined;
    }

    await this.userDeviceRepository.save(
      UserDevice.create({
        id,
        userId,
        label,
        userAgentSummary,
      }),
    );

    return id;
  }

  private toKnownDevice(
    device: UserDevice,
    currentDeviceId: string | undefined,
  ): KnownUserDevice {
    const primitives = device.toPrimitives();

    return {
      ...primitives,
      current: primitives.id === currentDeviceId,
    };
  }
}

function hashDeviceId(userId: string, rawDeviceIdentity: string): string {
  return createHash('sha256')
    .update(`${userId}:${rawDeviceIdentity}`)
    .digest('hex');
}

function normalizeOptionalText(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  const normalized = value?.trim();

  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, maxLength);
}

function summarizeUserAgent(userAgent: string | undefined): string {
  const normalized = normalizeOptionalText(userAgent, 240);

  if (!normalized) {
    return 'Dispositivo sin navegador identificado';
  }

  const browser =
    matchFirst(normalized, [
      ['Edg/', 'Edge'],
      ['Chrome/', 'Chrome'],
      ['Firefox/', 'Firefox'],
      ['Safari/', 'Safari'],
    ]) ?? 'Navegador';
  const platform =
    matchFirst(normalized, [
      ['Windows', 'Windows'],
      ['Android', 'Android'],
      ['iPhone', 'iPhone'],
      ['iPad', 'iPad'],
      ['Mac OS X', 'macOS'],
      ['Linux', 'Linux'],
    ]) ?? 'plataforma no identificada';

  return `${browser} en ${platform}`;
}

function buildDeviceLabel(userAgentSummary: string): string {
  return userAgentSummary === 'Dispositivo sin navegador identificado'
    ? 'Dispositivo actual'
    : userAgentSummary;
}

function matchFirst(
  value: string,
  candidates: Array<[needle: string, label: string]>,
): string | undefined {
  return candidates.find(([needle]) => value.includes(needle))?.[1];
}
