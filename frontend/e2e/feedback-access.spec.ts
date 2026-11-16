import { expect, test } from '@playwright/test';

test('reports an access error without a session and receives a reference number', async ({ page }) => {
  await page.route('**/api/feedback/status', (route) => route.fulfill({ status: 401 }));
  await page.route('**/api/feedback/anonymous/status', (route) =>
    route.fulfill({ json: { available: true } }));
  let submitted: Record<string, string> | undefined;
  await page.route('**/api/feedback/anonymous', async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { id: submitted?.['submissionId'] } });
  });

  await page.goto('/login?authError=cognito_callback');
  await page.getByRole('link', { name: 'Reportar un problema de acceso' }).click();
  await expect(page.getByRole('heading', { name: 'Enviar un reporte' })).toBeVisible();
  await page.getByLabel('Tipo de reporte').selectOption('bug');
  await page.getByLabel('Descripción').fill('Volví del registro y apareció un error de acceso.');
  await page.getByRole('button', { name: 'Enviar reporte' }).click();

  await expect(page.getByText('Recibimos tu reporte.', { exact: false })).toBeVisible();
  expect(submitted).toEqual({
    category: 'bug',
    message: 'Volví del registro y apareció un error de acceso.',
    source: 'access',
    errorCode: 'oauth_callback',
    submissionId: expect.any(String),
  });
});
