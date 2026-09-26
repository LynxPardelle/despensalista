import { getUserErrorMessage } from '../../shared/user-error';
import { inject, Injectable } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { PantryService } from '../../core/services/pantry.service';
import * as PantryActions from './pantry.actions';

@Injectable()
export class PantryEffects {
  private readonly actions$ = inject(Actions);
  private readonly pantryService = inject(PantryService);

  readonly loadOverview$ = createEffect(() =>
    this.actions$.pipe(
      ofType(PantryActions.loadPantryOverview),
      switchMap(() =>
        this.pantryService.getPantryOverview().pipe(
          map((overview) => PantryActions.loadPantryOverviewSuccess({ overview })),
          catchError((error) =>
            of(
              PantryActions.loadPantryOverviewFailure({
                error: this.getErrorMessage(error),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  private getErrorMessage(error: unknown): string {
    return getUserErrorMessage(error);
  }
}
