import { Inject, Injectable } from '@nestjs/common';
import { SHOPPING_SHARE_TTL_MS } from '../constants/shopping-share-limits';
import { PANTRY_MUTATION_PORT, SHOPPING_SHARE_REPOSITORY } from '../tokens';
import { ShoppingShare } from '../../domain/entities/shopping-share.entity';
import { ShoppingShareRepository } from '../../domain/repositories/shopping-share.repository';
import {
  generateShoppingShareToken,
  hashShoppingShareToken,
} from '../utils/shopping-share-token';
import {
  ShoppingShareExpiredError,
  ShoppingShareNotFoundError,
  ShoppingShareRevokedError,
} from './shopping-share.errors';
import { PantryMutationPort } from '../ports/pantry-mutation.port';

@Injectable()
export class CreateShoppingShareUseCase {
  constructor(
    @Inject(PANTRY_MUTATION_PORT)
    private readonly pantryMutationPort: PantryMutationPort,
  ) {}

  async execute(params: {
    ownerUserId: string;
    text: string;
  }): Promise<{ share: ShoppingShare; token: string }> {
    const token = generateShoppingShareToken();
    const createdAt = new Date();
    const share = ShoppingShare.create({
      ownerUserId: params.ownerUserId,
      tokenHash: hashShoppingShareToken(token),
      text: params.text,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + SHOPPING_SHARE_TTL_MS),
    });

    return {
      share: await this.pantryMutationPort.createShoppingShare(share),
      token,
    };
  }
}

@Injectable()
export class ResolveShoppingShareUseCase {
  constructor(
    @Inject(SHOPPING_SHARE_REPOSITORY)
    private readonly shoppingShareRepository: ShoppingShareRepository,
  ) {}

  async execute(token: string): Promise<ShoppingShare> {
    const share = await this.shoppingShareRepository.findByTokenHash(
      hashShoppingShareToken(token),
    );

    if (!share) {
      throw new ShoppingShareNotFoundError();
    }

    if (share.isRevoked()) {
      throw new ShoppingShareRevokedError();
    }

    if (share.isExpired()) {
      throw new ShoppingShareExpiredError();
    }

    return share;
  }
}

@Injectable()
export class ListActiveShoppingSharesUseCase {
  constructor(
    @Inject(SHOPPING_SHARE_REPOSITORY)
    private readonly shoppingShareRepository: ShoppingShareRepository,
  ) {}

  async execute(ownerUserId: string): Promise<ShoppingShare[]> {
    return this.shoppingShareRepository.listActiveByOwnerUserId(
      ownerUserId,
      new Date(),
    );
  }
}

@Injectable()
export class RevokeShoppingShareUseCase {
  constructor(
    @Inject(SHOPPING_SHARE_REPOSITORY)
    private readonly shoppingShareRepository: ShoppingShareRepository,
    @Inject(PANTRY_MUTATION_PORT)
    private readonly pantryMutationPort: PantryMutationPort,
  ) {}

  async execute(params: {
    ownerUserId: string;
    token: string;
  }): Promise<ShoppingShare> {
    const share = await this.shoppingShareRepository.findByTokenHash(
      hashShoppingShareToken(params.token),
    );

    if (!share) {
      throw new ShoppingShareNotFoundError();
    }

    const expected = ShoppingShare.fromPrimitives(share.toPrimitives());
    share.revoke(params.ownerUserId);

    return this.pantryMutationPort.updateShoppingShare(expected, share);
  }
}

@Injectable()
export class RevokeShoppingShareByIdUseCase {
  constructor(
    @Inject(SHOPPING_SHARE_REPOSITORY)
    private readonly shoppingShareRepository: ShoppingShareRepository,
    @Inject(PANTRY_MUTATION_PORT)
    private readonly pantryMutationPort: PantryMutationPort,
  ) {}

  async execute(params: {
    ownerUserId: string;
    shareId: string;
  }): Promise<ShoppingShare> {
    const share = await this.shoppingShareRepository.findById(params.shareId);

    if (!share) {
      throw new ShoppingShareNotFoundError();
    }

    const expected = ShoppingShare.fromPrimitives(share.toPrimitives());
    share.revoke(params.ownerUserId);

    return this.pantryMutationPort.updateShoppingShare(expected, share);
  }
}
