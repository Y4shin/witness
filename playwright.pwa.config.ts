/**
 * Playwright configuration for nav-cache tests that require a stable SW version.
 *
 * These tests need a production build because SvelteKit dev mode (HMR) can
 * reinstall the service worker between cache writes and offline reloads,
 * causing the activate handler to evict the nav-cache unexpectedly.
 *
 * Usage:
 *   npm run build
 *   npx playwright test --config playwright.pwa.config.ts
 */
import { defineConfig } from '@playwright/test';

// Signal to nav-cache tests that they are running against a stable production build
process.env.TEST_PROD_BUILD = 'true';

export default defineConfig({
	globalSetup: './tests/global-setup.ts',
	webServer: {
		command: 'node build/index.js',
		port: 4173,
		timeout: 30000,
		env: {
			DATABASE_URL: 'file:./tests/test.db',
			TEST_MODE: 'true',
			ADMIN_PASSWORD: 'test-admin-password',
			PORT: '4173'
		}
	},
	use: {
		baseURL: 'http://localhost:4173'
	},
	testMatch: '**/*.e2e.{ts,js}'
});
