import { expect, test } from '@playwright/test';

test('renders Cognito login options and starts provider redirect', async ({
  page,
}) => {
  await page.route('**/api/auth/cognito/providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ providers: ['COGNITO', 'Google', 'Facebook'] }),
    });
  });

  await page.route('**/api/auth/cognito/login?**', async (route) => {
    await route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<meta http-equiv="refresh" content="0; url=/login?cognitoRedirect=stubbed">',
    });
  });

  await page.goto('/login?redirectTo=%2Fpantry');

  await expect(page.getByRole('button', { name: 'Entrar con Google' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Entrar con Facebook' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Entrar con correo' }),
  ).toBeVisible();
  await expect(page.locator('input[type="email"], input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Crear cuenta con correo' })).toHaveAttribute(
    'href', '/api/auth/cognito/login?provider=COGNITO&redirectTo=%2Fpantry&flow=signup',
  );
  await expect(page.getByRole('link', { name: 'Recuperar contraseña de DespensaLista' })).toHaveAttribute(
    'href', '/api/auth/cognito/login?provider=COGNITO&redirectTo=%2Fpantry&flow=recovery',
  );
  await page.getByText('Ayuda con Google', { exact: true }).click();
  await expect(page.getByRole('link', { name: 'Recuperar mi cuenta de Google' })).toHaveAttribute(
    'href', 'https://accounts.google.com/signin/recovery',
  );

  const startedLogin = page.waitForRequest('**/api/auth/cognito/login?**');
  await page.getByRole('button', { name: 'Entrar con Google' }).click();
  expect(new URL((await startedLogin).url()).searchParams.get('provider')).toBe('Google');

  await expect(page).toHaveURL(/cognitoRedirect=stubbed/);
});

test('shows a recoverable message after an expired Cognito callback state', async ({
  page,
}) => {
  await page.goto('/login?authError=cognito_state');

  await expect(page.getByRole('alert')).toContainText(
    'El inicio de sesión caducó o se abrió otro intento.',
  );
  await expect(page.getByRole('link', { name: 'Reportar un problema de acceso' })).toHaveAttribute(
    'href', '/feedback?source=access&errorCode=oauth_callback',
  );
});

test('offers a report for an unexpected callback error with its public category', async ({ page }) => {
  await page.goto('/login?authError=cognito_unexpected');

  await expect(page.getByRole('alert')).toContainText('No pudimos verificar tu acceso en este momento.');
  await expect(page.getByRole('link', { name: 'Reportar un problema de acceso' })).toHaveAttribute(
    'href', '/feedback?source=access&errorCode=unexpected',
  );
});
