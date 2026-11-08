const { test, expect } = require('@playwright/test');
const catalog = require('./catalog.json');

const loginPath = '/web/index.php/auth/login';
const dashboardPath = '/web/index.php/dashboard/index';

function scenario(index, implementation) {
  const definition = catalog.scenarios[index];
  test(`${definition.id} ${definition.title}`, implementation);
}

async function expectLogin(page) {
  await expect(page).toHaveURL(/\/auth\/login(?:\?.*)?$/);
  await expect(page.getByRole('button', { name: 'Login', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toHaveCount(0);
}

async function login(page) {
  await page.goto(loginPath);
  const credentialText = await page.locator('.orangehrm-demo-credentials').innerText();
  const username = process.env.ORANGEHRM_USERNAME || credentialText.match(/Username\s*:\s*(\S+)/)?.[1];
  const password = process.env.ORANGEHRM_PASSWORD || credentialText.match(/Password\s*:\s*(\S+)/)?.[1];
  if (!username || !password) throw new Error('Runtime demo credentials unavailable');
  await page.getByPlaceholder('Username', { exact: true }).fill(username);
  await page.getByPlaceholder('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/index(?:\?.*)?$/);
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
}

scenario(0, async ({ page }) => {
  await login(page);
});

scenario(1, async ({ page }) => {
  await page.goto(loginPath);
  await page.getByPlaceholder('Username', { exact: true }).fill('nonexistent-regression-account');
  await page.getByPlaceholder('Password', { exact: true }).fill('invalid-regression-value');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByText('Invalid credentials', { exact: true })).toBeVisible();
  await expectLogin(page);
  await page.goto(dashboardPath);
  await expectLogin(page);
});

scenario(2, async ({ page }) => {
  await page.goto(loginPath);
  const submit = page.getByRole('button', { name: 'Login', exact: true });
  const username = page.getByPlaceholder('Username', { exact: true });
  const password = page.getByPlaceholder('Password', { exact: true });
  await submit.click();
  await expect(page.getByText('Required', { exact: true })).toHaveCount(2);
  await username.fill('nonexistent-regression-account');
  await submit.click();
  await expect(password.locator('..').locator('..').getByText('Required', { exact: true })).toBeVisible();
  await username.clear();
  await password.fill('invalid-regression-value');
  await submit.click();
  await expect(username.locator('..').locator('..').getByText('Required', { exact: true })).toBeVisible();
  await expectLogin(page);
});

scenario(3, async ({ page }) => {
  await login(page);
  await page.locator('.oxd-userdropdown-tab').click();
  await page.getByRole('menuitem', { name: 'Logout', exact: true }).click();
  await expectLogin(page);
  await page.goto(dashboardPath);
  await expectLogin(page);
});

scenario(4, async ({ page }) => {
  await page.goto(dashboardPath);
  await expectLogin(page);
});