import { Inject, Injectable } from '@nestjs/common';
import { Product } from '../../domain/entities/product.entity';
import { SchedulingService } from '../../domain/services/scheduling.service';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { UsageRate } from '../../domain/value-objects/usage-rate.vo';
import { QuantityUnit, ProductCategory } from '../../domain/enums';
import { Period } from '../../domain/enums/period.enum';
import { CreateProductCommand } from '../ports/commands/create-product.command';
import { PANTRY_MUTATION_PORT, SCHEDULING_SERVICE } from '../tokens';
import { PantryMutationPort } from '../ports/pantry-mutation.port';

@Injectable()
export class CreateProductUseCase {
  constructor(
    @Inject(PANTRY_MUTATION_PORT)
    private readonly pantryMutationPort: PantryMutationPort,
    @Inject(SCHEDULING_SERVICE)
    private readonly schedulingService: SchedulingService,
  ) {}

  async execute(command: CreateProductCommand): Promise<Product> {
    // Validar y convertir datos de entrada
    const userId = UserId.fromString(command.userId);
    const usageRate = new UsageRate(
      command.usageRate.amount,
      Period[command.usageRate.period.toUpperCase() as keyof typeof Period],
    );
    const unit =
      QuantityUnit[command.unit.toUpperCase() as keyof typeof QuantityUnit];
    const category =
      ProductCategory[
        command.category.toUpperCase() as keyof typeof ProductCategory
      ];

    // Crear entidad de dominio
    const product = Product.create(
      userId,
      command.title,
      command.currentQuantity,
      unit,
      usageRate,
      category,
    );

    // Aplicar lógica de dominio
    product.calculateNextPurchaseDate(this.schedulingService);

    // Persistir
    return this.pantryMutationPort.createProduct(product);
  }
}
