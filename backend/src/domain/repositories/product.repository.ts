import { Product } from '../entities/product.entity';
import { ProductId } from '../value-objects/product-id.vo';
import { UserId } from '../value-objects/user-id.vo';
import { ProductCategory, ProductStatus } from '../enums';

export interface ProductFilter {
  userId?: string;
  category?: ProductCategory;
  status?: ProductStatus;
}

export interface ProductRepository {
  findById(id: ProductId): Promise<Product | null>;
  findByUserId(userId: UserId): Promise<Product[]>;
  findByCategory(category: ProductCategory): Promise<Product[]>;
  findByStatus(status: ProductStatus): Promise<Product[]>;
  deleteByUserId(userId: UserId): Promise<number>;
  findAll(filter?: ProductFilter): Promise<Product[]>;
}
