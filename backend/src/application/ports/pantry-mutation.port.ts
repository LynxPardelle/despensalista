import {
  InventoryLot,
  InventoryLotPrimitives,
} from '../../domain/entities/inventory-lot.entity';
import { ProductType } from '../../domain/entities/product-type.entity';
import { WasteEvent } from '../../domain/entities/waste-event.entity';
import { ShoppingList } from '../../domain/entities/shopping-list.entity';
import { Product } from '../../domain/entities/product.entity';
import { ShoppingShare } from '../../domain/entities/shopping-share.entity';

export type PantryOperation =
  | 'consume_inventory_lot'
  | 'close_shopping_purchase'
  | 'delete_pantry_data';

export interface PantryDeletionResult {
  deletedInventoryLotCount: number;
  deletedProductTypeCount: number;
  deletedShoppingListCount: number;
  deletedShoppingShareCount: number;
  deletedWasteEventCount: number;
}

export interface PantryOperationContext {
  operationId: string;
  ownerUserId: string;
  operation: PantryOperation;
  requestHash: string;
  createdAt: Date;
  expiresAt: Date;
}

export type PantryOperationLookup = PantryOperationContext;

export interface PantryOperationReceipt extends PantryOperationContext {
  response:
    | InventoryLotPrimitives
    | InventoryLotPrimitives[]
    | PantryDeletionResult
    | null;
}

export interface PantryDeletionReceipt extends PantryOperationContext {
  operation: 'delete_pantry_data';
  response: PantryDeletionResult;
}

export interface IdempotentMutationResult<T> {
  value: T;
  replayed: boolean;
}

export interface ConsumeInventoryLotMutation {
  receipt: PantryOperationContext;
  expectedLot: InventoryLot;
  updatedLot: InventoryLot | null;
  wasteEvent?: WasteEvent;
}

export interface ProductTypeTransactionChange {
  expected: ProductType;
  updated: ProductType;
  changed: boolean;
}

export interface CloseShoppingPurchaseMutation {
  receipt: PantryOperationContext;
  lots: InventoryLot[];
  productTypes: ProductTypeTransactionChange[];
}

export interface PantryDeletionRequest {
  deletionToken?: string;
  retainFence?: boolean;
}

export interface PantryMutationPort {
  findReceipt(
    lookup: PantryOperationLookup,
  ): Promise<PantryOperationReceipt | null>;
  consume(
    mutation: ConsumeInventoryLotMutation,
  ): Promise<IdempotentMutationResult<InventoryLotPrimitives | null>>;
  checkout(
    mutation: CloseShoppingPurchaseMutation,
  ): Promise<IdempotentMutationResult<InventoryLotPrimitives[]>>;
  createInventoryLot(lot: InventoryLot): Promise<InventoryLot>;
  archiveInventoryLot(
    expected: InventoryLot,
    archived: InventoryLot,
  ): Promise<InventoryLot>;
  restoreInventoryLot(
    expected: InventoryLot,
    restored: InventoryLot,
  ): Promise<InventoryLot>;
  createProductType(productType: ProductType): Promise<ProductType>;
  archiveProductType(
    expected: ProductType,
    archived: ProductType,
  ): Promise<ProductType>;
  restoreProductType(
    expected: ProductType,
    restored: ProductType,
  ): Promise<ProductType>;
  createShoppingList(list: ShoppingList): Promise<ShoppingList>;
  createProduct(product: Product): Promise<Product>;
  updateProduct(expected: Product, updated: Product): Promise<Product>;
  createShoppingShare(share: ShoppingShare): Promise<ShoppingShare>;
  updateShoppingShare(
    expected: ShoppingShare,
    updated: ShoppingShare,
  ): Promise<ShoppingShare>;
  deleteShoppingList(list: ShoppingList): Promise<void>;
  deleteInventoryLot(lot: InventoryLot): Promise<void>;
  beginProductTypeDeletion(productType: ProductType): Promise<void>;
  deleteProductType(productType: ProductType): Promise<void>;
  updateProductType(
    expected: ProductType,
    updated: ProductType,
  ): Promise<ProductType>;
  beginPantryDeletion(
    ownerUserId: string,
    request?: PantryDeletionRequest,
  ): Promise<string>;
  completePantryDeletion(
    ownerUserId: string,
    deletionToken: string,
    retainFence?: boolean,
    receipt?: PantryDeletionReceipt,
  ): Promise<void>;
  abortPantryDeletion(
    ownerUserId: string,
    deletionToken: string,
  ): Promise<void>;
}

export class IdempotencyPayloadConflictError extends Error {
  constructor() {
    super('Idempotency-Key was already used with a different request');
    this.name = 'IdempotencyPayloadConflictError';
  }
}

export class PantryMutationConflictError extends Error {
  constructor(message = 'Pantry changed while the operation was running') {
    super(message);
    this.name = 'PantryMutationConflictError';
  }
}

export class PantryQuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PantryQuotaExceededError';
  }
}
