import { defineConfig } from '@playwright/test';

export default defineConfig({
	globalSetup: './tests/global-setup.ts',
	webServer: {
		command: 'npm run dev',
		port: 5173,
		reuseExistingServer: false,
		env: {
			DATABASE_URL: 'file:./tests/test.db',
			TEST_MODE: 'true',
			ADMIN_PASSWORD: 'test-admin-password'
		}
	},
	use: {
		baseURL: 'http://localhost:5173'
	},
	testMatch: '**/*.e2e.{ts,js}'
});
