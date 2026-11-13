import { DOCUMENT } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of, throwError } from 'rxjs';
import { AuthApiService } from '../../core/services/auth-api.service';
import { AuthFacade } from '../../core/services/auth.facade';
import { GoogleMfaPageComponent } from './google-mfa-page.component';

describe('GoogleMfaPageComponent', () => {
  let fixture: ComponentFixture<GoogleMfaPageComponent>;
  let api: jasmine.SpyObj<AuthApiService>;
  let replace: jasmine.Spy;
  let returnUrl: string;
  const response = { id: 'test-credential' };

  beforeEach(() => {
    returnUrl = '/profile?householdInvite=test';
    api = jasmine.createSpyObj('AuthApiService', ['getGoogleMfaStatus', 'getGoogleMfaOptions', 'verifyGoogleMfa']);
    api.getGoogleMfaStatus.and.returnValue(of({ registered: false, verified: false }));
    api.verifyGoogleMfa.and.returnValue(of(undefined));
    const auth = jasmine.createSpyObj('AuthFacade', ['logout'], { authError$: of(null) });
    replace = jasmine.createSpy('replace');

    TestBed.configureTestingModule({
      imports: [GoogleMfaPageComponent],
      providers: [
        { provide: AuthApiService, useValue: api },
        { provide: AuthFacade, useValue: auth },
        { provide: ActivatedRoute, useValue: { get snapshot() {
          return { queryParamMap: convertToParamMap({ redirectTo: returnUrl }) };
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
    api.getGoogleMfaOptions.and.returnValue(of({ challenge: 'test-challenge' }));
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
    api.getGoogleMfaStatus.and.returnValue(of({ registered: true, verified: false }));
    api.getGoogleMfaOptions.and.returnValue(of({ challenge: 'test-challenge' }));
    (navigator.credentials.get as jasmine.Spy).and.rejectWith(new DOMException('', 'NotAllowedError'));
    await render();

    await click('Verificar llave de acceso');
    expect(api.verifyGoogleMfa).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(button('Verificar llave de acceso')?.disabled).toBeFalse();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('Inténtalo de nuevo');
  });

  it('keeps the route locked when the server rejects the key', async () => {
    api.getGoogleMfaStatus.and.returnValue(of({ registered: true, verified: false }));
    api.getGoogleMfaOptions.and.returnValue(of({ challenge: 'test-challenge' }));
    api.verifyGoogleMfa.and.returnValue(throwError(() => new Error('Rejected')));
    await render();

    await click('Verificar llave de acceso');
    expect(api.verifyGoogleMfa).toHaveBeenCalledOnceWith('authentication', response);
    expect(replace).not.toHaveBeenCalled();
    expect(button('Verificar llave de acceso')?.disabled).toBeFalse();
  });

  it('falls back to the pantry when an already verified session requests an external destination', async () => {
    returnUrl = '//external.example';
    api.getGoogleMfaStatus.and.returnValue(of({ registered: true, verified: true }));
    await render();

    expect(replace).toHaveBeenCalledOnceWith('/pantry');
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
