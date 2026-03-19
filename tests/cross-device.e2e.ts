/**
 * E2E tests for Step 18: cross-device key linking.
 *
 * Tests cover:
 *  - Generating a link with passphrase → import on another browser context → same key
 *  - Wrong passphrase shows error
 *  - Opening /import with no fragment shows "link is incomplete" error
 *  - Opening /import with a corrupted fragment shows an error
 */
import { test, expect, chromium } from '@playwright/test';

// ── helpers ──────────────────────────────────────────────────────────────────

async function generateUserKeys() {
	const signing = await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
	);
	const encryption = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
	);
	return {
		signing,
		encryption,
		signingPublicKey: JSON.parse(JSON.stringify(await crypto.subtle.exportKey('jwk', signing.publicKey))),
		signingPrivateKey: JSON.parse(JSON.stringify(await crypto.subtle.exportKey('jwk', signing.privateKey))),
		encryptionPublicKey: JSON.parse(JSON.stringify(await crypto.subtle.exportKey('jwk', encryption.publicKey))),
		encryptionPrivateKey: JSON.parse(JSON.stringify(await crypto.subtle.exportKey('jwk', encryption.privateKey)))
	};
}

// ── tests ─────────────────────────────────────────────────────────────────────

test.describe('cross-device linking', () => {
	test('/import with no fragment shows incomplete error', async ({ page }) => {
		await page.goto('/import');
		await page.waitForLoadState('networkidle');
		await expect(page.getByRole('alert')).toBeVisible({ timeout: 5000 });
		const text = await page.getByRole('alert').textContent();
		expect(text).toMatch(/incomplete|invalid/i);
	});

	test('/import with corrupted fragment shows error', async ({ page }) => {
		await page.goto('/import#this-is-not-valid-base64-json!!!');
		await page.waitForLoadState('networkidle');
		await expect(page.getByRole('alert')).toBeVisible({ timeout: 5000 });
		const text = await page.getByRole('alert').textContent();
		expect(text).toMatch(/incomplete|invalid/i);
	});

	test('link-device page shows warning if no keys are stored', async ({ page }) => {
		// Fresh context — no keys
		await page.goto('/link-device');
		await page.waitForLoadState('networkidle');
		await expect(page.getByRole('alert')).toBeVisible({ timeout: 5000 });
	});

	test('generate link then import with correct passphrase succeeds', async ({
		page,
		request,
		browser
	}) => {
		const keys = await generateUserKeys();

		// Seed user in DB
		const userRes = await request.post('/api/_test/seed', {
			data: {
				type: 'user',
				signingPublicKey: JSON.stringify(keys.signingPublicKey),
				encryptionPublicKey: JSON.stringify(keys.encryptionPublicKey)
			}
		});
		expect(userRes.status()).toBe(200);

		// Store keys in page A's localStorage and navigate to link-device
		const keyBundle = {
			signingPublicKey: keys.signingPublicKey,
			signingPrivateKey: keys.signingPrivateKey,
			encryptionPublicKey: keys.encryptionPublicKey,
			encryptionPrivateKey: keys.encryptionPrivateKey
		};
		await page.goto('/link-device');
		await page.evaluate((bundle) => {
			localStorage.setItem('rt:keys', JSON.stringify(bundle));
		}, keyBundle);
		await page.reload();
		await page.waitForLoadState('networkidle');

		// Fill in passphrase and generate
		await page.getByLabel('Passphrase').fill('correct-horse-battery-staple');
		await page.getByLabel('Confirm passphrase').fill('correct-horse-battery-staple');
		await page.getByTestId('generate-link-btn').click();

		// Get the generated URL
		const importUrl = await page.getByTestId('import-url').inputValue({ timeout: 10000 });
		expect(importUrl).toMatch(/\/import#/);

		// Open a fresh browser context (simulate another device)
		const ctx2 = await browser.newContext();
		const page2 = await ctx2.newPage();

		await page2.goto(importUrl);
		await page2.waitForLoadState('networkidle');

		// Should show passphrase prompt
		await expect(page2.getByTestId('passphrase-input')).toBeVisible({ timeout: 5000 });

		// Enter correct passphrase
		await page2.getByTestId('passphrase-input').fill('correct-horse-battery-staple');
		await page2.getByTestId('import-btn').click();

		// Should redirect to dashboard
		await page2.waitForURL('/dashboard', { timeout: 15000 });

		// Keys should be in localStorage on page 2
		const storedKeys = await page2.evaluate(() => localStorage.getItem('rt:keys'));
		expect(storedKeys).toBeTruthy();
		const parsed = JSON.parse(storedKeys!);
		expect(parsed.signingPublicKey).toBeDefined();
		expect(parsed.encryptionPrivateKey).toBeDefined();

		await ctx2.close();
	});

	test('wrong passphrase shows error and does not store keys', async ({ page, request }) => {
		const keys = await generateUserKeys();

		const userRes = await request.post('/api/_test/seed', {
			data: {
				type: 'user',
				signingPublicKey: JSON.stringify(keys.signingPublicKey),
				encryptionPublicKey: JSON.stringify(keys.encryptionPublicKey)
			}
		});
		expect(userRes.status()).toBe(200);

		const keyBundle = {
			signingPublicKey: keys.signingPublicKey,
			signingPrivateKey: keys.signingPrivateKey,
			encryptionPublicKey: keys.encryptionPublicKey,
			encryptionPrivateKey: keys.encryptionPrivateKey
		};
		await page.goto('/link-device');
		await page.evaluate((bundle) => {
			localStorage.setItem('rt:keys', JSON.stringify(bundle));
		}, keyBundle);
		await page.reload();

		await page.getByLabel('Passphrase').fill('correct-passphrase-12345');
		await page.getByLabel('Confirm passphrase').fill('correct-passphrase-12345');
		await page.getByTestId('generate-link-btn').click();
		const importUrl = await page.getByTestId('import-url').inputValue({ timeout: 10000 });

		// New context, wrong passphrase
		const ctx2 = await page.context().browser()!.newContext();
		const page2 = await ctx2.newPage();
		await page2.goto(importUrl);
		await page2.waitForLoadState('networkidle');

		await page2.getByTestId('passphrase-input').fill('wrong-passphrase');
		await page2.getByTestId('import-btn').click();

		await expect(page2.getByRole('alert')).toBeVisible({ timeout: 5000 });
		const alertText = await page2.getByRole('alert').textContent();
		expect(alertText).toMatch(/wrong passphrase|decryption failed/i);

		// Keys should NOT be stored
		const storedKeys = await page2.evaluate(() => localStorage.getItem('rt:keys'));
		expect(storedKeys).toBeNull();

		await ctx2.close();
	});
});
