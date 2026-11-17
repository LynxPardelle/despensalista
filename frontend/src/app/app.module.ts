import { NgModule } from '@angular/core';
import { BrowserModule, provideClientHydration, withEventReplay } from '@angular/platform-browser';
import { provideHttpClient, withFetch, withInterceptors, withXsrfConfiguration } from '@angular/common/http';
import { ReactiveFormsModule } from '@angular/forms';
import { StoreModule } from '@ngrx/store';
import { EffectsModule } from '@ngrx/effects';
import { StoreDevtoolsModule } from '@ngrx/store-devtools';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { LoginPageComponent } from './features/auth/login-page.component';
import { authReducer } from './store/auth/auth.reducer';
import { AuthEffects } from './store/auth/auth.effects';
import { productReducer } from './store/product/product.reducer';
import { ProductEffects } from './store/product/product.effects';
import { pantryReducer } from './store/pantry/pantry.reducer';
import { PantryEffects } from './store/pantry/pantry.effects';
import { environment } from '../environments/environment';
import { pantryHouseholdInterceptor } from './core/services/pantry-household-scope';

@NgModule({
  declarations: [
    AppComponent,
    LoginPageComponent,
  ],
  imports: [
    BrowserModule,
    ReactiveFormsModule,
    AppRoutingModule,
    StoreModule.forRoot({
      auth: authReducer,
      products: productReducer,
      pantry: pantryReducer,
    }),
    EffectsModule.forRoot([AuthEffects, ProductEffects, PantryEffects]),
    ...(environment.enableDevTools
      ? [StoreDevtoolsModule.instrument({
          maxAge: 25,
          logOnly: environment.production,
        })]
      : [])
  ],
  providers: [
    provideHttpClient(
      withFetch(),
      withInterceptors([pantryHouseholdInterceptor]),
      withXsrfConfiguration({
        cookieName: 'XSRF-TOKEN',
        headerName: 'x-xsrf-token',
      }),
    ),
    ...(environment.enableHydration
      ? [provideClientHydration(withEventReplay())]
      : []),
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }
