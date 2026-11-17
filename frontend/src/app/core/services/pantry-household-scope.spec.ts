import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../../environments/environment';
import { PantryHouseholdScope, pantryHouseholdInterceptor } from './pantry-household-scope';

describe('pantry household request scope', () => {
  const api = environment.apiUrl;
  let client: HttpClient;
  let requests: HttpTestingController;
  let scope: PantryHouseholdScope;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [
      provideHttpClient(withInterceptors([pantryHouseholdInterceptor])),
      provideHttpClientTesting(),
    ] });
    client = TestBed.inject(HttpClient);
    requests = TestBed.inject(HttpTestingController);
    scope = TestBed.inject(PantryHouseholdScope);
  });

  afterEach(() => requests.verify());

  it('scopes internal pantry writes and leaves read and other requests unchanged', () => {
    scope.bind('home-origin');
    for (const path of ['/pantry/checkout', '/product-types', '/products', '/inventory-lots/lot/consume']) {
      client.post(`${api}${path}`, {}).subscribe();
      const request = requests.expectOne(`${api}${path}`);
      expect(request.request.headers.get('X-Despensa-Household')).toBe('home-origin');
      request.flush({});
    }
    client.delete(`${api}/profile/pantry-data`).subscribe();
    const deletion = requests.expectOne(`${api}/profile/pantry-data`);
    expect(deletion.request.headers.get('X-Despensa-Household')).toBe('home-origin');
    deletion.flush({});
    client.get(`${api}/pantry/overview`).subscribe();
    const read = requests.expectOne(`${api}/pantry/overview`);
    expect(read.request.headers.has('X-Despensa-Household')).toBeFalse();
    read.flush({});
    client.post(`${api}/household/invites/accept`, {}).subscribe();
    const invite = requests.expectOne(`${api}/household/invites/accept`);
    expect(invite.request.headers.has('X-Despensa-Household')).toBeFalse();
    invite.flush({});
  });

  it('blocks writes until a household is known and after the api rejects the bound household', () => {
    const url = `${api}/product-types`;
    const errors: string[] = [];
    const record = (error: HttpErrorResponse) => errors.push(error.error.code);
    client.post(url, {}).subscribe({ error: record });
    requests.expectNone(url);
    expect(scope.bind('home-origin')).toBeTrue();
    client.post(url, {}).subscribe({ error: record });
    requests.expectOne(url).flush({ code: 'HOUSEHOLD_ORIGIN_MISMATCH' }, { status: 409, statusText: 'Conflict' });
    expect(scope.stale()).toBeTrue();
    expect(scope.bind('home-new')).toBeFalse();
    client.post(url, {}).subscribe({ error: record });
    requests.expectNone(url);
    expect(errors).toEqual(['HOUSEHOLD_CONTEXT_UNAVAILABLE', 'HOUSEHOLD_ORIGIN_MISMATCH', 'HOUSEHOLD_ORIGIN_MISMATCH']);
  });
});
