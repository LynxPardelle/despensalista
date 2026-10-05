import { getUserErrorMessage } from '../../shared/user-error';
import { inject, Injectable } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { of } from 'rxjs';
import { catchError, exhaustMap, map, switchMap } from 'rxjs/operators';
import { ProductService } from '../../core/services/product.service';
import * as ProductActions from './product.actions';

@Injectable()
export class ProductEffects {
  private readonly actions$ = inject(Actions);
  private readonly productService = inject(ProductService);

  
  loadProducts$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ProductActions.loadProducts),
      switchMap(() =>
        this.productService.getProducts().pipe(
          map((products) => ProductActions.loadProductsSuccess({ products })),
          catchError((error) => of(ProductActions.loadProductsFailure({ error: this.getErrorMessage(error) })))
        )
      )
    )
  );

  createProduct$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ProductActions.createProduct),
      exhaustMap(({ product }) =>
        this.productService.createProduct(product).pipe(
          map((createdProduct) => ProductActions.createProductSuccess({ product: createdProduct })),
          catchError((error) => of(ProductActions.createProductFailure({ error: this.getErrorMessage(error) })))
        )
      )
    )
  );

  updateProductQuantity$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ProductActions.updateProductQuantity),
      exhaustMap(({ productId, quantity }) =>
        this.productService.updateProductQuantity(productId, quantity).pipe(
          map((product) => ProductActions.updateProductQuantitySuccess({ product })),
          catchError((error) => of(ProductActions.updateProductQuantityFailure({ error: this.getErrorMessage(error) })))
        )
      )
    )
  );

  private getErrorMessage(error: unknown): string {
    return getUserErrorMessage(error);
  }
}
