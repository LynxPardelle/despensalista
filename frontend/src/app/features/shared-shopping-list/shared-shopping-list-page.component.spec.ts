import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  HttpClientTestingModule,
  HttpTestingController,
} from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { SharedShoppingListPageComponent } from './shared-shopping-list-page.component';
import { environment } from '../../../environments/environment';

describe('SharedShoppingListPageComponent', () => {
  let fixture: ComponentFixture<SharedShoppingListPageComponent>;
  let httpMock: HttpTestingController;

  afterEach(() => {
    httpMock?.verify();
  });

  it('renders a server-backed temporary shopping list token', async () => {
    fixture = await createComponent('opaque-token');

    const request = httpMock.expectOne(
      `${environment.apiUrl}/shopping-shares/opaque-token`,
    );
    expect(request.request.withCredentials).toBeFalse();
    request.flush({
      text: 'Lista de compras Despensa Lista\n- Arroz: 2 kg',
      createdAt: '2026-05-19T12:00:00.000Z',
      expiresAt: '2099-05-19T12:00:00.000Z',
    });
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const textarea = compiled.querySelector<HTMLTextAreaElement>(
      '.shopping-export-text',
    );

    expect(compiled.textContent).toContain('Lista compartida');
    expect(textarea?.value).toContain('Arroz: 2 kg');
    expect(
      compiled.querySelector<HTMLAnchorElement>('.whatsapp-link')?.href,
    ).toContain('https://wa.me/');
  });

  it('rejects an unsigned legacy shopping list payload', async () => {
    const token = toBase64Url(
      JSON.stringify({
        version: 1,
        type: 'shopping-list',
        createdAt: '2026-05-19T12:00:00.000Z',
        expiresAt: '2099-05-19T12:00:00.000Z',
        text: 'Lista de compras Despensa Lista\n- Arroz: 2 kg',
      }),
    );
    fixture = await createComponent(token);

    const request = httpMock.expectOne(
      `${environment.apiUrl}/shopping-shares/${token}`,
    );
    request.flush(
      { message: 'not found' },
      {
        status: 404,
        statusText: 'Not Found',
      },
    );
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Enlace inválido');
    expect(compiled.querySelector('.shopping-export-text')).toBeNull();
  });

  it('does not trust expiry from an unsigned legacy payload', async () => {
    const token = toBase64Url(
      JSON.stringify({
        version: 1,
        type: 'shopping-list',
        createdAt: '2026-05-01T12:00:00.000Z',
        expiresAt: '2026-05-02T12:00:00.000Z',
        text: 'Lista caducada',
      }),
    );
    fixture = await createComponent(token);

    const request = httpMock.expectOne(
      `${environment.apiUrl}/shopping-shares/${token}`,
    );
    request.flush(
      { message: 'not found' },
      {
        status: 404,
        statusText: 'Not Found',
      },
    );
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;

    expect(compiled.textContent).toContain('Enlace inválido');
    expect(compiled.querySelector('.shopping-export-text')).toBeNull();
  });

  it('distinguishes a retryable server failure from an invalid token', async () => {
    fixture = await createComponent('opaque-token');

    const request = httpMock.expectOne(
      `${environment.apiUrl}/shopping-shares/opaque-token`,
    );
    request.flush(
      { message: 'unavailable' },
      {
        status: 503,
        statusText: 'Service Unavailable',
      },
    );
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;

    expect(compiled.textContent).toContain('No pudimos cargar la lista');
    expect(compiled.querySelector<HTMLButtonElement>('.retry-button')).not.toBeNull();
  });

  async function createComponent(token: string) {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, SharedShoppingListPageComponent],
      providers: [
        {
          provide: ActivatedRoute,
          useValue: {
            queryParamMap: of(convertToParamMap({ token })),
          },
        },
      ],
    }).compileComponents();

    const componentFixture = TestBed.createComponent(
      SharedShoppingListPageComponent,
    );
    httpMock = TestBed.inject(HttpTestingController);
    componentFixture.detectChanges();

    return componentFixture;
  }

  function toBase64Url(value: string): string {
    return btoa(value)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }
});
