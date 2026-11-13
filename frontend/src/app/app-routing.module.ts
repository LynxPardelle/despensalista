import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AuthGuard } from './core/guards/auth.guard';
import { LoginPageComponent } from './features/auth/login-page.component';

const routes: Routes = [
  {
    path: 'login',
    component: LoginPageComponent,
    canActivate: [AuthGuard],
    data: {
      authMode: 'anonymous',
    },
  },
  {
    path: 'register',
    redirectTo: 'login',
  },
  {
    path: 'mfa-google',
    title: 'Verifica tu acceso | DespensaLista',
    loadComponent: () => import('./features/auth/google-mfa-page.component').then(
      (module) => module.GoogleMfaPageComponent,
    ),
  },
  {
    path: 'forgot-password',
    redirectTo: 'login',
  },
  {
    path: 'reset-password',
    redirectTo: 'login',
  },
  {
    path: 'claim-imported-account',
    redirectTo: 'login',
  },
  {
    path: 'shared-shopping-list',
    loadComponent: () =>
      import(
        './features/shared-shopping-list/shared-shopping-list-page.component'
      ).then((module) => module.SharedShoppingListPageComponent),
  },
  {
    path: 'privacidad',
    loadComponent: () =>
      import('./features/legal/privacy-page.component').then(
        (module) => module.PrivacyPageComponent,
      ),
  },
  {
    path: 'pantry',
    loadChildren: () =>
      import('./features/pantry/pantry.module').then(
        (module) => module.PantryModule,
      ),
    canActivate: [AuthGuard],
    data: {
      authMode: 'authenticated',
    },
  },
  {
    path: 'profile',
    loadComponent: () =>
      import('./features/profile/profile-page.component').then(
        (module) => module.ProfilePageComponent,
      ),
    canActivate: [AuthGuard],
    data: {
      authMode: 'authenticated',
    },
  },
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'pantry',
  },
  {
    path: '**',
    redirectTo: 'pantry',
  },
];

@NgModule({
  imports: [RouterModule.forRoot(routes, {
    scrollPositionRestoration: 'enabled',
  })],
  exports: [RouterModule]
})
export class AppRoutingModule { }
