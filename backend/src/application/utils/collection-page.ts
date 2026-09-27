import { BadRequestException } from '@nestjs/common';

export interface CollectionPageOptions {
  cursor?: string;
  limit?: number;
}

export function collectionPage<T extends { id: { toString(): string } }>(
  items: T[],
  scope: string,
  options: CollectionPageOptions,
) {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new BadRequestException('Page limit must be between 1 and 100');
  }
  let after = '';
  if (options.cursor) {
    try {
      const decoded = JSON.parse(
        Buffer.from(options.cursor, 'base64url').toString('utf8'),
      ) as { scope?: unknown; after?: unknown };
      if (decoded.scope !== scope || typeof decoded.after !== 'string')
        throw new Error();
      after = decoded.after;
    } catch {
      throw new BadRequestException('Invalid collection cursor');
    }
  }
  // ponytail: active collections are capped at 1,000 items; move keyset reads into storage if that quota grows.
  const remaining = items
    .filter((item) => item.id.toString() > after)
    .sort((a, b) => (a.id.toString() < b.id.toString() ? -1 : 1));
  const pageItems = remaining.slice(0, limit);
  const hasMore = remaining.length > limit;
  return {
    items: pageItems,
    pagination: {
      limit,
      hasMore,
      nextCursor: hasMore
        ? Buffer.from(
            JSON.stringify({ scope, after: pageItems.at(-1)!.id.toString() }),
          ).toString('base64url')
        : undefined,
    },
  };
}
