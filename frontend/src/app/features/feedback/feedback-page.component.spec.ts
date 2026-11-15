import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FeedbackPageComponent } from './feedback-page.component';

describe('FeedbackPageComponent', () => {
  let fixture: ComponentFixture<FeedbackPageComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FeedbackPageComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    fixture = TestBed.createComponent(FeedbackPageComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('only shows the form when the current environment accepts reports', () => {
    http.expectOne('/api/feedback/status').flush({ available: false });
    fixture.detectChanges();

    expect(page().querySelector('form')).toBeNull();
    expect(page().textContent).toContain('no está disponible');
  });

  it('reuses the same receipt on retry and clears the message after acknowledged delivery', () => {
    http.expectOne('/api/feedback/status').flush({ available: true });
    fixture.detectChanges();
    const category = page().querySelector('select')!;
    category.value = 'suggestion';
    category.dispatchEvent(new Event('change'));
    const message = page().querySelector('textarea')!;
    message.value = '  Agregar una pista cuando se cambia la lista.  ';
    message.dispatchEvent(new Event('input'));

    submit();
    const first = http.expectOne({ method: 'POST', url: '/api/feedback' });
    expect(first.request.body).toEqual({
      category: 'suggestion',
      message: 'Agregar una pista cuando se cambia la lista.',
      submissionId: jasmine.any(String),
    });
    first.flush({}, { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();
    expect(message.value).toContain('Agregar una pista');

    submit();
    const retry = http.expectOne({ method: 'POST', url: '/api/feedback' });
    expect(retry.request.body).toEqual(first.request.body);
    retry.flush({ id: first.request.body.submissionId });
    fixture.detectChanges();

    expect(page().textContent).toContain('Recibimos tu reporte');
    expect(page().textContent).toContain(first.request.body.submissionId);
    expect(message.value).toBe('');
  });

  function page(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }
  function submit(): void {
    page().querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    fixture.detectChanges();
  }
});
