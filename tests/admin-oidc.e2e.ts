import { expect, test } from '@playwright/test';

async function completeOidcLogin(
	page: import('@playwright/test').Page,
	identity: { email: string }
) {
	await page.goto('/admin/login');
	await expect(page.getByRole('link', { name: 'Continue with OpenID Connect' })).toBeVisible();

	await page.getByRole('link', { name: 'Continue with OpenID Connect' }).click();
	await expect(page).toHaveURL(/127\.0\.0\.1:5544/);

	await page.getByPlaceholder('Enter any login').fill(identity.email);
	await page.getByPlaceholder('and password').fill('test-password');
	await page.getByRole('button', { name: 'Sign-in' }).click();

	await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
	await page.getByRole('button', { name: 'Continue' }).click();
}

test.describe('admin console oidc login', () => {
	test('allowed oidc identity can access the admin console', async ({ page }) => {
		await completeOidcLogin(page, {
			email: 'admin@example.com'
		});

		await expect(page).toHaveURL('/admin');
		await expect(page.locator('h1')).toHaveText('Admin console');
	});

	test('unapproved oidc identity is bounced back to the login page with an error', async ({
		page
	}) => {
		await completeOidcLogin(page, {
			email: 'outsider@example.com'
		});

		await expect(page).toHaveURL(/\/admin\/login\?error=/);
		await expect(page.locator('[role=alert]')).toContainText('not allowed');
		await expect(page.locator('h1')).toHaveText('Admin login');
	});
});
