import * as oidc from 'oidc-provider';

const port = Number(process.env.OIDC_TEST_PROVIDER_PORT ?? '5544');
const issuer = process.env.OIDC_TEST_PROVIDER_ISSUER ?? `http://127.0.0.1:${port}`;
const clientId = process.env.OIDC_TEST_PROVIDER_CLIENT_ID ?? 'reporting-tool-e2e';
const clientSecret = process.env.OIDC_TEST_PROVIDER_CLIENT_SECRET ?? 'reporting-tool-e2e-secret';
const redirectUri =
	process.env.OIDC_TEST_PROVIDER_REDIRECT_URI ?? 'http://localhost:5174/admin/login/oidc/callback';

const provider = new oidc.Provider(issuer, {
	clients: [
		{
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uris: [redirectUri],
			response_types: ['code'],
			grant_types: ['authorization_code'],
			token_endpoint_auth_method: 'client_secret_post'
		}
	],
	claims: {
		openid: ['sub'],
		email: ['email', 'email_verified'],
		profile: ['name']
	},
	async findAccount(_ctx, accountId) {
		const email = accountId.toLowerCase();
		return {
			accountId,
			async claims(_use, scope) {
				const claims = { sub: accountId };
				if (scope?.includes('email')) {
					Object.assign(claims, {
						email,
						email_verified: true
					});
				}
				if (scope?.includes('profile')) {
					Object.assign(claims, {
						name: email.split('@')[0] ?? accountId
					});
				}
				return claims;
			}
		};
	},
	pkce: {
		required: () => true
	}
});

provider.listen(port, '127.0.0.1', () => {
	console.log(
		`OIDC test provider listening on ${issuer} with discovery at ${issuer}/.well-known/openid-configuration`
	);
});
