import { UnauthorizedException } from '@nestjs/common';
import { UserDao } from '../ports/daos';
import { CognitoProfileSyncService } from './cognito-profile-sync.service';
import { User } from '../../domain/entities/user.entity';
import { UserAccountStatus } from '../../domain/enums';

describe('CognitoProfileSyncService', () => {
  const makeUserDao = (): jest.Mocked<UserDao> => ({
    save: jest.fn((user) => Promise.resolve(user)),
    findById: jest.fn(),
    findByAuthSubject: jest.fn(),
    findByEmail: jest.fn(),
    findByUsername: jest.fn(),
    beginAccountDeletion: jest.fn(),
    findPendingAccountDeletions: jest.fn(),
    claimPendingAccountDeletion: jest.fn(),
    deferAccountDeletion: jest.fn(),
    delete: jest.fn(),
  });

  const makeService = (userDao = makeUserDao()) => ({
    service: new CognitoProfileSyncService(userDao),
    userDao,
  });

  const makeUser = (overrides?: {
    id?: string;
    email?: string;
    username?: string;
    status?: UserAccountStatus;
  }) =>
    User.fromPrimitives({
      id: overrides?.id ?? 'cognito-sub-existing',
      email: overrides?.email ?? 'old@example.com',
      username: overrides?.username ?? 'old-name',
      status: overrides?.status ?? UserAccountStatus.ACTIVE,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

  it('creates a local app profile with Cognito sub as User.id', async () => {
    const { service, userDao } = makeService();
    userDao.findById.mockResolvedValue(null);
    userDao.findByUsername.mockResolvedValue(null);

    const user = await service.syncFromClaims({
      sub: 'cognito-sub-123',
      email: 'CHEF@Example.COM',
      emailVerified: true,
      preferredUsername: 'Chef',
    });

    expect(user.id.toString()).toBe('cognito-sub-123');
    expect(user.email).toBe('chef@example.com');
    expect(user.username).toBe('Chef');
    expect(user.authSubjectIds).toEqual(['cognito-sub-123']);
    expect(userDao.save.mock.calls[0]?.[0]).toBe(user);
  });

  it('updates an existing local profile without changing disabled status', async () => {
    const { service, userDao } = makeService();
    const existing = makeUser({
      id: 'cognito-sub-disabled',
      status: UserAccountStatus.DISABLED,
    });
    userDao.findById.mockResolvedValue(existing);
    userDao.findByUsername.mockResolvedValue(null);

    const user = await service.syncFromClaims({
      sub: 'cognito-sub-disabled',
      email: 'new@example.com',
      emailVerified: true,
      name: 'Nuevo Nombre',
    });

    expect(user.email).toBe('new@example.com');
    expect(user.username).toBe('Nuevo Nombre');
    expect(user.authSubjectIds).toEqual(['cognito-sub-disabled']);
    expect(user.status).toBe(UserAccountStatus.DISABLED);
  });

  it('rejects Cognito claims without an email', async () => {
    const { service } = makeService();

    await expect(
      service.syncFromClaims({
        sub: 'cognito-sub-no-email',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('adds a stable suffix when the derived username is already owned by another user', async () => {
    const { service, userDao } = makeService();
    const otherUser = makeUser({
      id: 'different-sub',
      email: 'other@example.com',
      username: 'chef',
    });
    userDao.findById.mockResolvedValue(null);
    userDao.findByUsername.mockImplementation((username) =>
      Promise.resolve(username === 'chef' ? otherUser : null),
    );

    const user = await service.syncFromClaims({
      sub: '1234567890abcdef',
      email: 'chef@example.com',
      emailVerified: true,
    });

    expect(user.username).toBe('chef-12345678');
  });

  it('keeps the derived username when it belongs to the same Cognito user', async () => {
    const { service, userDao } = makeService();
    const existing = makeUser({
      id: 'same-sub',
      email: 'same@example.com',
      username: 'chef',
    });
    userDao.findById.mockResolvedValue(existing);
    userDao.findByUsername.mockImplementation((username) =>
      Promise.resolve(username === 'chef' ? existing : null),
    );

    const user = await service.syncFromClaims({
      sub: 'same-sub',
      email: 'same@example.com',
      emailVerified: true,
      preferredUsername: 'chef',
    });

    expect(user.username).toBe('chef');
  });

  it('links a verified Cognito subject to an existing Despensa Lista profile by email', async () => {
    const { service, userDao } = makeService();
    const existing = makeUser({
      id: 'stable-app-user',
      email: 'chef@example.com',
      username: 'chef',
    });
    userDao.findByAuthSubject.mockResolvedValue(null);
    userDao.findById.mockResolvedValue(null);
    userDao.findByEmail.mockResolvedValue(existing);
    userDao.findByUsername.mockResolvedValue(existing);

    const user = await service.syncFromClaims({
      sub: 'new-cognito-sub',
      email: 'CHEF@example.com',
      emailVerified: true,
      preferredUsername: 'chef',
    });

    expect(user.id.toString()).toBe('stable-app-user');
    expect(user.authSubjectIds).toEqual(['new-cognito-sub']);
  });

  it('rejects linking by email when Cognito has not verified the email claim', async () => {
    const { service, userDao } = makeService();
    userDao.findByAuthSubject.mockResolvedValue(null);
    userDao.findById.mockResolvedValue(null);
    userDao.findByEmail.mockResolvedValue(
      makeUser({
        id: 'existing-user',
        email: 'chef@example.com',
      }),
    );

    await expect(
      service.syncFromClaims({
        sub: 'new-cognito-sub',
        email: 'chef@example.com',
        emailVerified: false,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(userDao.save.mock.calls).toHaveLength(0);
  });
});
