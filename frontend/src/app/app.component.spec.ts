import { TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { AuthFacade } from './core/services/auth.facade';
import { AppComponent } from './app.component';

describe('AppComponent', () => {
  let authFacade: { bootstrap: jasmine.Spy };

  beforeEach(async () => {
    authFacade = {
      bootstrap: jasmine.createSpy('bootstrap'),
    };

    await TestBed.configureTestingModule({
      imports: [
        RouterTestingModule
      ],
      declarations: [
        AppComponent
      ],
      providers: [
        {
          provide: AuthFacade,
          useValue: authFacade,
        },
      ],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it(`should have as title 'Despensa Lista'`, () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app.title).toEqual('Despensa Lista');
  });

  it('should render the shell container', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.app-shell')).not.toBeNull();
  });

  it('does not bootstrap auth session from the app shell', () => {
    const fixture = TestBed.createComponent(AppComponent);

    fixture.detectChanges();

    expect(authFacade.bootstrap).not.toHaveBeenCalled();
  });

  it('keeps primary action colors at WCAG AA contrast', () => {
    const rootStyles = getComputedStyle(document.documentElement);
    const foreground = rootStyles.getPropertyValue('--color-primary-text').trim();
    const gradientColors = [
      rootStyles.getPropertyValue('--color-primary-start').trim(),
      rootStyles.getPropertyValue('--color-primary-end').trim(),
    ];

    expect(foreground).not.toBe('');
    gradientColors.forEach((background) => {
      expect(background).not.toBe('');
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    });
  });
});

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);

  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

function relativeLuminance(color: string): number {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);

  if (!match) {
    throw new Error(`Expected a six-digit hexadecimal color, received "${color}"`);
  }

  const channels = match.slice(1).map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;

    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
