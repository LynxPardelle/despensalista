import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { environment } from '../environments/environment';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  standalone: false,
  styleUrl: './app.component.scss'
})
export class AppComponent {
  readonly title = environment.appName;
  private readonly router = inject(Router);

  protected get reportUrl(): string | undefined {
    const segment = this.router.url.split(/[/?#]/)[1];
    switch (segment) {
      case 'feedback': return undefined;
      case 'login':
      case 'mfa-google': return '/feedback?source=access';
      case 'register': return '/feedback?source=registration';
      case 'forgot-password':
      case 'reset-password': return '/feedback?source=recovery';
      case 'profile': return '/feedback?source=profile';
      case 'pantry': return '/feedback?source=pantry';
      case 'shared-shopping-list': return '/feedback?source=share';
      default: return '/feedback?source=website';
    }
  }
}
