import { HttpErrorResponse } from '@angular/common/http';
import { getUserErrorMessage, UserFacingError } from './user-error';

describe('user error messages', () => {
  it('does not expose HTTP, persistence, or raw exception details', () => {
    for (const error of [
      new HttpErrorResponse({ status: 500, error: { message: 'DynamoDB AccessDenied table secret' } }),
      new HttpErrorResponse({ status: 400, error: { message: 'CastError mongodb private' } }),
      new Error('Internal stack private'),
    ]) {
      expect(getUserErrorMessage(error)).not.toMatch(/DynamoDB|AccessDenied|CastError|mongodb|private|Http failure/);
    }
  });
  it('preserves intentionally user-facing instructions', () => {
    expect(getUserErrorMessage(new UserFacingError('Revisa el inventario.'))).toBe('Revisa el inventario.');
  });
});
