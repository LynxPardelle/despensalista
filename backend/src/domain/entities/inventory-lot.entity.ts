import { ExpirationStatus, QuantityUnit } from '../enums';
import { InventoryLotId } from '../value-objects/inventory-lot-id.vo';
import { ProductTypeId } from '../value-objects/product-type-id.vo';
import { UserId } from '../value-objects/user-id.vo';

const DAY_IN_MS = 24 * 60 * 60 * 1000;

export interface InventoryLotPrimitives {
  id: string;
  userId: string;
  productTypeId: string;
  variantName?: string;
  quantity: number;
  unit: QuantityUnit;
  expiresAt?: Date;
  purchaseDate?: Date;
  archivedAt?: Date;
  archivedReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export class InventoryLot {
  private constructor(
    private readonly _id: InventoryLotId,
    private readonly _userId: UserId,
    private readonly _productTypeId: ProductTypeId,
    private _variantName: string | undefined,
    private _quantity: number,
    private readonly _unit: QuantityUnit,
    private _expiresAt: Date | undefined,
    private _purchaseDate: Date | undefined,
    private _archivedAt: Date | undefined,
    private _archivedReason: string | undefined,
    private readonly _createdAt: Date = new Date(),
    private _updatedAt: Date = new Date(),
  ) {}

  static create(
    userId: UserId,
    productTypeId: ProductTypeId,
    variantName: string | undefined,
    quantity: number,
    unit: QuantityUnit,
    expiresAt?: Date,
    purchaseDate?: Date,
  ): InventoryLot {
    if (quantity <= 0) {
      throw new Error('Quantity must be greater than zero');
    }

    return new InventoryLot(
      InventoryLotId.generate(),
      userId,
      productTypeId,
      normalizeOptionalText(variantName),
      quantity,
      unit,
      expiresAt,
      purchaseDate,
      undefined,
      undefined,
    );
  }

  static fromPrimitives(primitives: InventoryLotPrimitives): InventoryLot {
    return new InventoryLot(
      InventoryLotId.fromString(primitives.id),
      UserId.fromString(primitives.userId),
      ProductTypeId.fromString(primitives.productTypeId),
      primitives.variantName,
      primitives.quantity,
      primitives.unit,
      primitives.expiresAt,
      primitives.purchaseDate,
      primitives.archivedAt ? new Date(primitives.archivedAt) : undefined,
      normalizeOptionalText(primitives.archivedReason),
      primitives.createdAt,
      primitives.updatedAt,
    );
  }

  get id(): InventoryLotId {
    return this._id;
  }

  get userId(): UserId {
    return this._userId;
  }

  get productTypeId(): ProductTypeId {
    return this._productTypeId;
  }

  get variantName(): string | undefined {
    return this._variantName;
  }

  get quantity(): number {
    return this._quantity;
  }

  get unit(): QuantityUnit {
    return this._unit;
  }

  get expiresAt(): Date | undefined {
    return this._expiresAt;
  }

  get purchaseDate(): Date | undefined {
    return this._purchaseDate;
  }

  get archivedAt(): Date | undefined {
    return this._archivedAt ? new Date(this._archivedAt) : undefined;
  }

  get archivedReason(): string | undefined {
    return this._archivedReason;
  }

  get createdAt(): Date {
    return this._createdAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  consume(amount: number): void {
    if (amount <= 0) {
      throw new Error('Consume amount must be greater than zero');
    }

    if (amount > this._quantity) {
      throw new Error('Consume amount exceeds lot quantity');
    }

    this._quantity = Number((this._quantity - amount).toFixed(2));
    this._updatedAt = new Date(
      Math.max(Date.now(), this._updatedAt.getTime() + 1),
    );
  }

  isEmpty(): boolean {
    return this._quantity <= 0;
  }

  archive(reason?: string): void {
    this._archivedAt = new Date();
    this._archivedReason = normalizeOptionalText(reason);
    this._updatedAt = new Date(
      Math.max(Date.now(), this._updatedAt.getTime() + 1),
    );
  }

  restore(): void {
    this._archivedAt = undefined;
    this._archivedReason = undefined;
    this._updatedAt = new Date(
      Math.max(Date.now(), this._updatedAt.getTime() + 1),
    );
  }

  isArchived(): boolean {
    return Boolean(this._archivedAt);
  }

  getDisplayName(): string {
    return this._variantName ?? this._id.toString();
  }

  assertDeleteConfirmation(confirmationText: string): void {
    if (confirmationText.trim() !== this.getDisplayName()) {
      throw new Error('Delete confirmation must match inventory lot name');
    }
  }

  canDeletePermanently(): boolean {
    return this.isArchived();
  }

  getExpirationStatus(
    referenceDate: Date = new Date(),
    warningDays = 7,
  ): ExpirationStatus {
    if (!this._expiresAt) {
      return ExpirationStatus.NONE;
    }

    const daysUntilExpiration = getDayDifference(
      referenceDate,
      this._expiresAt,
    );

    if (daysUntilExpiration < 0) {
      return ExpirationStatus.EXPIRED;
    }

    if (daysUntilExpiration === 0) {
      return ExpirationStatus.CRITICAL;
    }

    if (daysUntilExpiration <= warningDays) {
      return ExpirationStatus.SOON;
    }

    return ExpirationStatus.STABLE;
  }

  isExpiringWithinDays(
    days: number,
    referenceDate: Date = new Date(),
  ): boolean {
    if (!this._expiresAt) {
      return false;
    }

    return getDayDifference(referenceDate, this._expiresAt) <= days;
  }

  toPrimitives(): InventoryLotPrimitives {
    return {
      id: this._id.toString(),
      userId: this._userId.toString(),
      productTypeId: this._productTypeId.toString(),
      variantName: this._variantName,
      quantity: this._quantity,
      unit: this._unit,
      expiresAt: this._expiresAt,
      purchaseDate: this._purchaseDate,
      archivedAt: this._archivedAt ? new Date(this._archivedAt) : undefined,
      archivedReason: this._archivedReason,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }
}

function normalizeOptionalText(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function getDayDifference(referenceDate: Date, targetDate: Date): number {
  return Math.floor(
    (toUtcDateOnlyTime(targetDate) - toUtcDateOnlyTime(referenceDate)) /
      DAY_IN_MS,
  );
}

function toUtcDateOnlyTime(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
