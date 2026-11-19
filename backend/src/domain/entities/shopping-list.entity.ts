import { randomUUID } from 'crypto';
import { MAX_SAVED_SHOPPING_LIST_ITEMS } from '../../application/constants/query-limits';
import { QuantityUnit } from '../enums';
import { UserId } from '../value-objects/user-id.vo';

export interface ShoppingListItemPrimitives {
  productTypeId: string;
  baseName: string;
  quantity: number;
  unit: QuantityUnit;
  shoppingLocation?: string;
  estimatedUnitPrice?: number;
  estimatedLineTotal?: number;
}

export interface ShoppingListPrimitives {
  id: string;
  ownerUserId: string;
  title: string;
  occasion?: string;
  shoppingLocation?: string;
  items: ShoppingListItemPrimitives[];
  createdAt: Date;
  updatedAt: Date;
}

export class ShoppingList {
  private constructor(
    private readonly _id: string,
    private readonly _ownerUserId: UserId,
    private readonly _title: string,
    private readonly _occasion: string | undefined,
    private readonly _shoppingLocation: string | undefined,
    private readonly _items: ShoppingListItemPrimitives[],
    private readonly _createdAt: Date,
    private readonly _updatedAt: Date,
  ) {}

  static create(params: {
    ownerUserId: string;
    title: string;
    occasion?: string;
    shoppingLocation?: string;
    items: ShoppingListItemPrimitives[];
    now?: Date;
  }): ShoppingList {
    const now = params.now ?? new Date();

    return new ShoppingList(
      randomUUID(),
      UserId.fromString(params.ownerUserId),
      normalizeLimitedText(params.title, 80, 'Shopping list title'),
      normalizeOptionalLimitedText(
        params.occasion,
        80,
        'Shopping list occasion',
      ),
      normalizeOptionalLimitedText(
        params.shoppingLocation,
        80,
        'Shopping list location',
      ),
      normalizeItems(params.items),
      now,
      now,
    );
  }

  static fromPrimitives(primitives: ShoppingListPrimitives): ShoppingList {
    return new ShoppingList(
      normalizeLimitedText(primitives.id, 120, 'Shopping list id'),
      UserId.fromString(primitives.ownerUserId),
      normalizeLimitedText(primitives.title, 80, 'Shopping list title'),
      normalizeOptionalLimitedText(
        primitives.occasion,
        80,
        'Shopping list occasion',
      ),
      normalizeOptionalLimitedText(
        primitives.shoppingLocation,
        80,
        'Shopping list location',
      ),
      normalizeItems(primitives.items),
      new Date(primitives.createdAt),
      new Date(primitives.updatedAt),
    );
  }

  get id(): string {
    return this._id;
  }

  get ownerUserId(): string {
    return this._ownerUserId.toString();
  }

  assertOwnedBy(ownerUserId: string): void {
    if (this.ownerUserId !== UserId.fromString(ownerUserId).toString()) {
      throw new Error('Shopping list is not owned by current user');
    }
  }

  toPrimitives(): ShoppingListPrimitives {
    return {
      id: this._id,
      ownerUserId: this.ownerUserId,
      title: this._title,
      occasion: this._occasion,
      shoppingLocation: this._shoppingLocation,
      items: this._items.map((item) => ({ ...item })),
      createdAt: new Date(this._createdAt),
      updatedAt: new Date(this._updatedAt),
    };
  }
}

function normalizeItems(
  items: ShoppingListItemPrimitives[],
): ShoppingListItemPrimitives[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Shopping list must include at least one item');
  }

  if (items.length > MAX_SAVED_SHOPPING_LIST_ITEMS) {
    throw new Error(
      `Shopping list cannot exceed ${MAX_SAVED_SHOPPING_LIST_ITEMS} items`,
    );
  }

  return items.map((item) => {
    if (!Object.values(QuantityUnit).includes(item.unit)) {
      throw new Error('Shopping list item unit is not supported');
    }

    return {
      productTypeId: normalizeLimitedText(
        item.productTypeId,
        120,
        'Shopping list item product type id',
      ),
      baseName: normalizeLimitedText(
        item.baseName,
        80,
        'Shopping list item name',
      ),
      quantity: normalizePositiveAmount(
        item.quantity,
        'Shopping list item quantity',
      ),
      unit: item.unit,
      shoppingLocation: normalizeOptionalLimitedText(
        item.shoppingLocation,
        80,
        'Shopping list item location',
      ),
      estimatedUnitPrice: normalizeOptionalMoney(
        item.estimatedUnitPrice,
        'Shopping list item unit price',
      ),
      estimatedLineTotal: normalizeOptionalMoney(
        item.estimatedLineTotal,
        'Shopping list item total',
      ),
    };
  });
}

function normalizePositiveAmount(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    throw new Error(`${label} must be between 0.01 and 1000000`);
  }

  return Number(value.toFixed(2));
}

function normalizeOptionalMoney(
  value: number | null | undefined,
  label: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return normalizePositiveAmount(value, label);
}

function normalizeLimitedText(
  value: string,
  maxLength: number,
  label: string,
): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error(`${label} cannot be empty`);
  }

  if (normalized.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer`);
  }

  return normalized;
}

function normalizeOptionalLimitedText(
  value: string | undefined,
  maxLength: number,
  label: string,
): string | undefined {
  const normalized = value?.trim();

  if (!normalized) {
    return undefined;
  }

  if (normalized.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer`);
  }

  return normalized;
}
