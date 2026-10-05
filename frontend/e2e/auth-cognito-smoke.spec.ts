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
      status: 302,
      headers: {
        location: '/login?cognitoRedirect=stubbed',
      },
    });
  });

  await page.goto('/login');

  await expect(page.getByRole('button', { name: 'Entrar con Google' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Entrar con Facebook' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Entrar con correo' }),
  ).toBeVisible();
  await expect(page.getByLabel('Correo')).toHaveCount(0);
  await expect(page.getByLabel('Password')).toHaveCount(0);

  await page.getByRole('button', { name: 'Entrar con Google' }).click();

  await expect(page).toHaveURL(/cognitoRedirect=stubbed/);
});

test('shows a recoverable message after an expired Cognito callback state', async ({
  page,
}) => {
  await page.goto('/login?authError=cognito_state');

  await expect(page.getByRole('alert')).toContainText(
    'El inicio de sesion caduco o se abrio otro intento.',
  );
});
