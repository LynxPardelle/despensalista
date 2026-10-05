import { collectionPage } from './collection-page';

describe('collectionPage', () => {
  it('returns every item once and binds the cursor to its collection', () => {
    const items = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
    const first = collectionPage(items, 'owner:types', { limit: 2 });
    expect(first.items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(first.pagination.hasMore).toBe(true);
    const second = collectionPage(items, 'owner:types', {
      limit: 2,
      cursor: first.pagination.nextCursor,
    });
    expect(second.items).toEqual([{ id: 'c' }]);
    expect(second.pagination.hasMore).toBe(false);
    expect(() =>
      collectionPage(items, 'another:types', {
        cursor: first.pagination.nextCursor,
      }),
    ).toThrow('cursor');
    expect(() => collectionPage(items, 'owner:types', { limit: 101 })).toThrow(
      'limit',
    );
  });
});
