import { DOCUMENT } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of, throwError } from 'rxjs';
import { AuthApiService } from '../../core/services/auth-api.service';
import { AuthFacade } from '../../core/services/auth.facade';
import { GoogleMfaStatus } from '../../shared/models/auth.model';
import { GoogleMfaPageComponent } from './google-mfa-page.component';

describe('GoogleMfaPageComponent', () => {
  let fixture: ComponentFixture<GoogleMfaPageComponent>;
  let api: jasmine.SpyObj<AuthApiService>;
  let replace: jasmine.Spy;
  let returnUrl: string;
  let manage: boolean;
  const response = { id: 'test-credential' };
  const options: PublicKeyCredentialCreationOptionsJSON = {
    challenge: 'test-challenge',
    pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
    rp: { id: 'localhost', name: 'Test RP' },
    user: { id: 'test-user', name: 'Test user', displayName: 'Test user' },
  };

  beforeEach(() => {
    returnUrl = '/profile?householdInvite=test';
    manage = false;
    api = jasmine.createSpyObj('AuthApiService', [
      'getGoogleMfaStatus', 'getGoogleMfaOptions', 'verifyGoogleMfa', 'generateGoogleMfaRecoveryCode',
    ]);
    api.getGoogleMfaStatus.and.returnValue(of(makeStatus()));
    api.getGoogleMfaOptions.and.returnValue(of(options));
    api.verifyGoogleMfa.and.returnValue(of(undefined));
    const auth = jasmine.createSpyObj('AuthFacade', ['logout'], { authError$: of(null) });
    replace = jasmine.createSpy('replace');

    TestBed.configureTestingModule({
      imports: [GoogleMfaPageComponent],
      providers: [
        { provide: AuthApiService, useValue: api },
        { provide: AuthFacade, useValue: auth },
        { provide: ActivatedRoute, useValue: { get snapshot() {
          return { queryParamMap: convertToParamMap({ redirectTo: returnUrl, manage: manage ? '1' : '0' }) };
        } } },
      ],
    });
    TestBed.overrideComponent(GoogleMfaPageComponent, {
      add: { providers: [{ provide: DOCUMENT, useValue: { location: { replace } } }] },
    });

    const credential = Object.create(PublicKeyCredential.prototype) as PublicKeyCredential;
    Object.defineProperty(credential, 'toJSON', { value: () => response });
    spyOn(PublicKeyCredential, 'parseCreationOptionsFromJSON').and.returnValue({} as PublicKeyCredentialCreationOptions);
    spyOn(PublicKeyCredential, 'parseRequestOptionsFromJSON').and.returnValue({} as PublicKeyCredentialRequestOptions);
    spyOn(navigator.credentials, 'create').and.resolveTo(credential);
    spyOn(navigator.credentials, 'get').and.resolveTo(credential);
  });

  it('requires a separate authentication after registering a key', async () => {
    await render();
    expect(navigator.credentials.create).not.toHaveBeenCalled();
    expect(button('Verificar llave de acceso')).toBeUndefined();

    await click('Registrar llave de acceso');
    expect(api.verifyGoogleMfa).toHaveBeenCalledOnceWith('registration', response);
    expect(replace).not.toHaveBeenCalled();
    expect(navigator.credentials.get).not.toHaveBeenCalled();

    await click('Verificar llave de acceso');
    expect(api.verifyGoogleMfa).toHaveBeenCalledWith('authentication', response);
    expect(replace).toHaveBeenCalledOnceWith(returnUrl);
  });

  it('keeps the route locked when the key prompt is canceled', async () => {
    api.getGoogleMfaStatus.and.returnValue(of(makeStatus({ registered: true, keyCount: 1 })));
    (navigator.credentials.get as jasmine.Spy).and.rejectWith(new DOMException('', 'NotAllowedError'));
    await render();

    await click('Verificar llave de acceso');
    expect(api.verifyGoogleMfa).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(button('Verificar llave de acceso')?.disabled).toBeFalse();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('Inténtalo de nuevo');
  });

  it('keeps the route locked when the server rejects the key', async () => {
    api.getGoogleMfaStatus.and.returnValue(of(makeStatus({ registered: true, keyCount: 1 })));
    api.verifyGoogleMfa.and.returnValue(throwError(() => new Error('Rejected')));
    await render();

    await click('Verificar llave de acceso');
    expect(api.verifyGoogleMfa).toHaveBeenCalledOnceWith('authentication', response);
    expect(replace).not.toHaveBeenCalled();
    expect(button('Verificar llave de acceso')?.disabled).toBeFalse();
  });

  it('falls back to the pantry when an already verified session requests an external destination', async () => {
    returnUrl = '//external.example';
    api.getGoogleMfaStatus.and.returnValue(of(makeStatus({ registered: true, verified: true, keyCount: 1 })));
    await render();

    expect(replace).toHaveBeenCalledOnceWith('/pantry');
  });

  it('requires confirming an existing key before adding a second key', async () => {
    manage = true;
    const status = {
      registered: true, verified: true, keyCount: 1, recoveryConfigured: false, recentVerification: false,
    };
    api.getGoogleMfaStatus.and.returnValue(of(status));
    await render();

    expect(replace).not.toHaveBeenCalled();
    expect(button('Agregar una segunda llave')).toBeUndefined();
    expect(button('Generar código de recuperación')).toBeUndefined();

    await click('Confirmar con una llave');
    expect(api.verifyGoogleMfa).toHaveBeenCalledOnceWith('authentication', response);
    expect(replace).not.toHaveBeenCalled();

    await click('Agregar una segunda llave');
    expect(api.verifyGoogleMfa).toHaveBeenCalledWith('registration', response);
    expect(button('Agregar una segunda llave')).toBeUndefined();
    expect(fixture.nativeElement.textContent).toContain('2 de 2 llaves registradas');
  });

  it('offers recovery when the account configured a recovery code', async () => {
    const status = {
      registered: true, verified: false, keyCount: 2, recoveryConfigured: true, recentVerification: false,
    };
    api.getGoogleMfaStatus.and.returnValue(of(status));
    await render();

    expect(button('Recuperar acceso con un código')).toBeDefined();
    expect(button('Registrar una llave nueva')).toBeUndefined();
    await click('Recuperar acceso con un código');
    expect(fixture.nativeElement.querySelector('input[type="password"]')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('llaves anteriores');
  });

  it('asks for fresh key confirmation when the server reports that recent verification expired', async () => {
    manage = true;
    api.getGoogleMfaStatus.and.returnValue(of(makeStatus({
      registered: true, verified: true, keyCount: 1, recentVerification: true,
    })));
    api.generateGoogleMfaRecoveryCode.and.returnValue(throwError(() => new HttpErrorResponse({
      status: 403, error: { code: 'GOOGLE_MFA_REQUIRED' },
    })));
    await render();
    await click('Generar código de recuperación');

    expect(button('Confirmar con una llave')).toBeDefined();
    expect(button('Generar código de recuperación')).toBeUndefined();
    expect(fixture.nativeElement.textContent).toContain('Confirma de nuevo con una llave');
    expect(replace).not.toHaveBeenCalled();
  });

  it('uses the offline code without storing it and requires a separate assertion after replacing the keys', async () => {
    api.getGoogleMfaStatus.and.returnValue(of(makeStatus({ registered: true, keyCount: 2, recoveryConfigured: true })));
    const storage = spyOn(Storage.prototype, 'setItem');
    await render();
    await click('Recuperar acceso con un código');
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input[type="password"]');
    input.value = '  AbC_recoveryTest12345  ';
    await click('Registrar una llave nueva');

    expect(api.getGoogleMfaOptions).toHaveBeenCalledOnceWith('recovery', 'AbC_recoveryTest12345');
    expect(api.verifyGoogleMfa).toHaveBeenCalledOnceWith('recovery', response);
    expect(storage).not.toHaveBeenCalled();
    expect(input.value).toBe('');
    expect(replace).not.toHaveBeenCalled();
    expect(button('Recuperar acceso con un código')).toBeUndefined();
    expect(fixture.nativeElement.textContent).toContain('genera otro código');

    await click('Verificar llave de acceso');
    expect(api.verifyGoogleMfa).toHaveBeenCalledWith('authentication', response);
    expect(replace).toHaveBeenCalledOnceWith(returnUrl);
  });

  it('shows the new recovery code once and asks before invalidating a configured code', async () => {
    manage = true;
    api.getGoogleMfaStatus.and.returnValue(of(makeStatus({
      registered: true, verified: true, keyCount: 1, recentVerification: true,
    })));
    api.generateGoogleMfaRecoveryCode.and.returnValues(of({ code: 'first-test-code' }), of({ code: 'second-test-code' }));
    const storage = spyOn(Storage.prototype, 'setItem');
    await render();
    await click('Generar código de recuperación');
    expect(fixture.nativeElement.querySelector('#google-mfa-recovery-code').textContent).toBe('first-test-code');
    expect(button('Volver al perfil')?.disabled).toBeTrue();
    await click('Ya guardé el código');
    expect(fixture.nativeElement.querySelector('#google-mfa-recovery-code')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('first-test-code');

    await click('Reemplazar código de recuperación');
    expect(api.generateGoogleMfaRecoveryCode).toHaveBeenCalledTimes(1);
    expect(fixture.nativeElement.textContent).toContain('el código anterior dejará de funcionar');
    await click('Generar código nuevo');
    expect(fixture.nativeElement.querySelector('#google-mfa-recovery-code').textContent).toBe('second-test-code');
    expect(storage).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('pagehide'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#google-mfa-recovery-code')).toBeNull();
  });

  async function render(): Promise<void> {
    fixture = TestBed.createComponent(GoogleMfaPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function button(label: string): HTMLButtonElement | undefined {
    const element: HTMLElement = fixture.nativeElement;
    return Array.from(element.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === label);
  }

  async function click(label: string): Promise<void> {
    button(label)!.click();
    await fixture.whenStable();
    fixture.detectChanges();
  }
});

function makeStatus(overrides: Partial<GoogleMfaStatus> = {}): GoogleMfaStatus {
  return { registered: false, verified: false, keyCount: 0, recoveryConfigured: false, recentVerification: false, ...overrides };
}
