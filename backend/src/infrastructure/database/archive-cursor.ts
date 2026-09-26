export interface ArchiveCursor extends Record<string, unknown> {
  archivedAt: string;
  id: string;
  userId: string;
}

export function decodeArchiveCursor(
  cursor: string | undefined,
  expectedUserId: string,
  errorMessage: string,
): ArchiveCursor | undefined {
  if (!cursor) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error();
    }
    const value = parsed as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(',') !== 'archivedAt,id,userId' ||
      typeof value['archivedAt'] !== 'string' ||
      !Number.isFinite(Date.parse(value['archivedAt'])) ||
      typeof value['id'] !== 'string' ||
      !value['id'] ||
      value['userId'] !== expectedUserId
    ) {
      throw new Error();
    }
    return value as unknown as ArchiveCursor;
  } catch {
    throw new Error(errorMessage);
  }
}
