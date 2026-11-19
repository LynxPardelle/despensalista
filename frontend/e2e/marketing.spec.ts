import { expect, test } from '@playwright/test';

test('the public landing is readable in the initial HTML and links to the plans', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.ok()).toBe(true);
  const html = await response!.text();
  expect(html).toContain('id="hero-title"');
  expect(html).toContain('https://despensalista.com/marketing/despensa-social.jpg');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Tu despensa,\s*a la vista\./);
  await expect(page.getByRole('link', { name: /Empieza gratis/ })).toHaveAttribute('href', '/login');
  await expect(page.getByRole('img', { name: /Una mano guarda un frasco/ })).toBeVisible();
  await expect.poll(() => page.getByRole('img', { name: /Una mano guarda un frasco/ })
    .evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('link', { name: 'Ver planes' }).click();
  await expect(page).toHaveURL(/\/planes\/?$/);
  await expect(page.getByRole('heading', { name: 'Planes para tu hogar' })).toBeVisible();
});

test('the public plans explain Gratis and show the full Plus price with sales closed', async ({ page }) => {
  const response = await page.goto('/planes');
  expect(response?.ok()).toBe(true);
  const html = await response!.text();
  expect(html).toContain('Apertura de suscripciones pendiente');
  expect(html).toMatch(/rel="canonical" href="https:\/\/despensalista\.com\/planes"/);

  const free = page.getByRole('article', { name: 'Gratis' });
  const plus = page.getByRole('article', { name: 'Plus Hogar' });
  await expect(free).toContainText('Hasta 2 integrantes');
  await expect(free.getByRole('link', { name: 'Empieza gratis' })).toHaveAttribute('href', '/login');
  await expect(plus).toContainText('$68.44');
  await expect(plus).toContainText('IVA incluido');
  await expect(plus.getByRole('button')).toHaveCount(0);

  const question = page.getByText('¿Qué pasa con mis datos si cancelo Plus Hogar?');
  await question.click();
  await expect(page.getByText('Después tu hogar vuelve a Gratis', { exact: false })).toBeVisible();
});

test('the plans skip link keeps keyboard navigation on the plans page', async ({ page }) => {
  await page.goto('/planes');
  const skipLink = page.getByRole('link', { name: 'Ir al contenido' });
  await skipLink.focus();
  await skipLink.press('Enter');

  await expect(page).toHaveURL(/\/planes#contenido$/);
  await expect(page.getByRole('heading', { name: 'Planes para tu hogar' })).toBeVisible();
});
