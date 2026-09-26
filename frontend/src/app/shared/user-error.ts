import { HttpErrorResponse } from '@angular/common/http';
import { TimeoutError } from 'rxjs';

export class UserFacingError extends Error {}

export function getUserErrorMessage(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof TimeoutError) return 'La solicitud tardó demasiado. Revisa tu conexión e intenta de nuevo.';
  if (error instanceof HttpErrorResponse) {
    switch (error.status) {
      case 0: return 'No pudimos conectar. Revisa tu conexión e intenta de nuevo.';
      case 400: return 'Revisa los datos ingresados e intenta de nuevo.';
      case 401: return 'Tu sesión caducó. Inicia sesión de nuevo.';
      case 403: return 'Tu cuenta no tiene permiso para realizar esta acción.';
      case 404: return 'Este elemento ya no está disponible. Actualiza la página.';
      case 409: return 'Los datos cambiaron o alcanzaste el límite permitido. Actualiza la despensa y revisa tu selección.';
      case 429: return 'Hay demasiados intentos. Espera un momento antes de volver a intentar.';
    }
  }
  return 'No se pudo completar la solicitud. Intenta de nuevo en unos momentos.';
}
