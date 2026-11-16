import { provideZoneChangeDetection } from '@angular/core';
import { platformBrowser } from '@angular/platform-browser';
import { AppModule } from './app/app.module';
import { environment } from './environments/environment';

platformBrowser()
  .bootstrapModule(AppModule, {
    applicationProviders: [
      provideZoneChangeDetection({ eventCoalescing: true }),
    ],
  })
  .then(() => registerDespensaListaServiceWorker())
  .catch((err) => console.error(err));

function registerDespensaListaServiceWorker(): void {
  if (!environment.production || !window.isSecureContext || !('serviceWorker' in navigator)) {
    return;
  }

  const register = () => {
    navigator.serviceWorker.register('/despensalista-sw.js', { updateViaCache: 'none' }).catch(() => {
      // Offline support is optional; a failed registration must not block login.
    });
  };

  if (document.readyState === 'complete') {
    register();
  } else {
    window.addEventListener('load', register, { once: true });
  }
}
