import { defineConfig } from '@playwright/test';

export default defineConfig({
	globalSetup: './tests/global-setup.ts',
	webServer: [
		{
			command: 'npm run dev -- --port 5173 --strictPort',
			port: 5173,
			reuseExistingServer: false,
			env: {
				DATABASE_URL: 'file:./tests/test.db',
				TEST_MODE: 'true',
				ADMIN_PASSWORD: 'test-admin-password'
			}
		},
		{
			command: 'node tests/oidc-provider.js',
			port: 5544,
			reuseExistingServer: false,
			env: {
				OIDC_TEST_PROVIDER_PORT: '5544',
				OIDC_TEST_PROVIDER_ISSUER: 'http://127.0.0.1:5544',
				OIDC_TEST_PROVIDER_CLIENT_ID: 'reporting-tool-e2e',
				OIDC_TEST_PROVIDER_CLIENT_SECRET: 'reporting-tool-e2e-secret'
			}
		},
		{
			command: 'npm run dev -- --port 5174 --strictPort',
			port: 5174,
			reuseExistingServer: false,
			env: {
				DATABASE_URL: 'file:./tests/test-oidc.db',
				TEST_MODE: 'true',
				ORIGIN: 'http://localhost:5174',
				ADMIN_AUTH_MODE: 'oidc',
				ADMIN_PASSWORD: '',
				ADMIN_OIDC_DISCOVERY_URL: 'http://127.0.0.1:5544',
				ADMIN_OIDC_CLIENT_ID: 'reporting-tool-e2e',
				ADMIN_OIDC_CLIENT_SECRET: 'reporting-tool-e2e-secret',
				ADMIN_OIDC_ALLOWED_EMAILS: 'admin@example.com'
			}
		}
	],
	projects: [
		{
			name: 'default',
			testIgnore: ['**/admin-oidc.e2e.ts'],
			use: {
				baseURL: 'http://localhost:5173'
			}
		},
		{
			name: 'oidc-admin',
			testMatch: ['**/admin-oidc.e2e.ts'],
			use: {
				baseURL: 'http://localhost:5174'
			}
		}
	],
	testMatch: '**/*.e2e.{ts,js}'
});
