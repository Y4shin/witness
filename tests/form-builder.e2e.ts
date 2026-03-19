/**
 * E2E tests for Step 11: form builder API.
 *
 * Tests cover GET/POST /api/projects/[id]/fields and
 * DELETE/PATCH /api/projects/[id]/fields/[fieldId].
 */
import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

// ── helpers ────────────────────────────────────────────────────────────────

function b64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

/**
 * Seeds a project + user + membership and authenticates via challenge-response.
 * Returns the authenticated request context and the project ID.
 */
async function authenticateMODERATOR(request: APIRequestContext) {
	return authenticateWithRole(request, 'MODERATOR');
}

async function authenticateWithRole(
	request: APIRequestContext,
	role: 'MODERATOR' | 'SUBMITTER',
	projectId?: string
) {
	const signing = await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['sign', 'verify']
	);
	const encryption = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		['deriveKey', 'deriveBits']
	);
	const signingPublicKey = JSON.stringify(await crypto.subtle.exportKey('jwk', signing.publicKey));
	const encryptionPublicKey = JSON.stringify(
		await crypto.subtle.exportKey('jwk', encryption.publicKey)
	);

	// Seed user
	const userRes = await request.post('/api/_test/seed', {
		data: { type: 'user', signingPublicKey, encryptionPublicKey }
	});
	expect(userRes.status()).toBe(200);
	const { userId } = await userRes.json();

	// Seed project if not provided
	if (!projectId) {
		const projRes = await request.post('/api/_test/seed', {
			data: { type: 'project', name: `Form Builder Test (${role})`, publicKey: encryptionPublicKey }
		});
		expect(projRes.status()).toBe(200);
		projectId = (await projRes.json()).projectId;
	}

	// Seed membership
	const memRes = await request.post('/api/_test/seed', {
		data: { type: 'membership', userId, projectId, role }
	});
	expect(memRes.status()).toBe(200);

	// Challenge-response auth
	const { nonce } = await (await request.get('/api/auth/challenge')).json();
	const sig = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		signing.privateKey,
		new TextEncoder().encode(nonce)
	);
	const signature = b64url(new Uint8Array(sig));
	const verifyRes = await request.post('/api/auth/verify', {
		data: { signingPublicKey, nonce, signature }
	});
	expect(verifyRes.status()).toBe(200);

	return { request, projectId: projectId! };
}

// ── tests ──────────────────────────────────────────────────────────────────

test.describe('form builder API', () => {
	test('MODERATOR creates a two-field form; fields are persisted and returned by GET', async ({
		request
	}) => {
		const { request: authed, projectId } = await authenticateMODERATOR(request);

		// Create first field
		const r1 = await authed.post(`/api/projects/${projectId}/fields`, {
			data: { label: 'Full name', type: 'TEXT', required: true, sortOrder: 0 }
		});
		expect(r1.status()).toBe(201);
		expect((await r1.json()).field.label).toBe('Full name');

		// Create second field (SELECT)
		const r2 = await authed.post(`/api/projects/${projectId}/fields`, {
			data: {
				label: 'Category',
				type: 'SELECT',
				options: ['Option A', 'Option B'],
				required: false,
				sortOrder: 1
			}
		});
		expect(r2.status()).toBe(201);
		const secondField = (await r2.json()).field;
		expect(secondField.label).toBe('Category');
		expect(JSON.parse(secondField.options)).toEqual(['Option A', 'Option B']);

		// Verify both fields are returned by GET
		const listRes = await authed.get(`/api/projects/${projectId}/fields`);
		expect(listRes.status()).toBe(200);
		const { fields } = await listRes.json();
		expect(fields).toHaveLength(2);
		expect(fields[0].label).toBe('Full name');
		expect(fields[1].label).toBe('Category');
	});

	test('MODERATOR can reorder fields via PATCH', async ({ request }) => {
		const { request: authed, projectId } = await authenticateMODERATOR(request);

		const f1 = (
			await authed.post(`/api/projects/${projectId}/fields`, {
				data: { label: 'First', type: 'TEXT', sortOrder: 0 }
			})
		);
		const fieldId = (await f1.json()).field.id;

		const patchRes = await authed.patch(`/api/projects/${projectId}/fields/${fieldId}`, {
			data: { sortOrder: 5 }
		});
		expect(patchRes.status()).toBe(200);
		expect((await patchRes.json()).field.sortOrder).toBe(5);
	});

	test('MODERATOR can delete a required field (no minimum-field guard)', async ({ request }) => {
		const { request: authed, projectId } = await authenticateMODERATOR(request);

		const createRes = await authed.post(`/api/projects/${projectId}/fields`, {
			data: { label: 'Only field', type: 'TEXT', required: true }
		});
		const fieldId = (await createRes.json()).field.id;

		const delRes = await authed.delete(`/api/projects/${projectId}/fields/${fieldId}`);
		expect(delRes.status()).toBe(200);

		const listRes = await authed.get(`/api/projects/${projectId}/fields`);
		expect((await listRes.json()).fields).toHaveLength(0);
	});

	test('submitter cannot create a field (403)', async ({ request }) => {
		// Set up project with an MODERATOR first (project must exist)
		const { request: MODERATORReq, projectId } = await authenticateMODERATOR(request);

		// Now authenticate a submitter into the same project
		const { request: submitterReq } = await authenticateWithRole(
			// Use a fresh context via a workaround: make a second request context
			// by passing a new Playwright request bound to the same API base
			MODERATORReq,
			'SUBMITTER',
			projectId
		);

		// The submitter's request context shares the cookie jar with the MODERATOR here.
		// Use a separate browser context fixture for isolation — but for API tests we
		// just need a distinct session. Since `request` fixtures are per-test and share
		// no cookies, we use a direct API approach with a fresh signing key instead.

		// Simpler: re-authenticate as a fresh submitter user on the SAME project.
		// The `request` context carries the last verify cookie, so we overwrite it.
		const { projectId: pid } = await authenticateWithRole(request, 'SUBMITTER', projectId);

		const r = await request.post(`/api/projects/${pid}/fields`, {
			data: { label: 'Should fail', type: 'TEXT' }
		});
		expect(r.status()).toBe(403);
		expect((await r.json()).message).toBeTruthy();
	});

	test('unauthenticated request to GET fields returns 401', async ({ request }) => {
		// Seed a project without authenticating — no session cookie on this context.
		const seedRes = await request.post('/api/_test/seed', {
			data: { type: 'project', name: 'Unauth test', publicKey: 'pk' }
		});
		const { projectId } = await seedRes.json();

		const res = await request.get(`/api/projects/${projectId}/fields`);
		expect(res.status()).toBe(401);
	});

	test('creating a field with empty label returns 400', async ({ request }) => {
		const { request: authed, projectId } = await authenticateMODERATOR(request);

		const r = await authed.post(`/api/projects/${projectId}/fields`, {
			data: { label: '', type: 'TEXT' }
		});
		expect(r.status()).toBe(400);
		expect((await r.json()).message).toBeTruthy();
	});

	test('creating a field with whitespace-only label returns 400', async ({ request }) => {
		const { request: authed, projectId } = await authenticateMODERATOR(request);

		const r = await authed.post(`/api/projects/${projectId}/fields`, {
			data: { label: '   ', type: 'TEXT' }
		});
		expect(r.status()).toBe(400);
	});

	test('creating a SELECT field with no options returns 400', async ({ request }) => {
		const { request: authed, projectId } = await authenticateMODERATOR(request);

		const r = await authed.post(`/api/projects/${projectId}/fields`, {
			data: { label: 'Category', type: 'SELECT', options: [] }
		});
		expect(r.status()).toBe(400);
		expect((await r.json()).message).toMatch(/option/i);
	});

	test('GET fields returns them ordered by sortOrder', async ({ request }) => {
		const { request: authed, projectId } = await authenticateMODERATOR(request);

		await authed.post(`/api/projects/${projectId}/fields`, {
			data: { label: 'Third', type: 'TEXT', sortOrder: 2 }
		});
		await authed.post(`/api/projects/${projectId}/fields`, {
			data: { label: 'First', type: 'TEXT', sortOrder: 0 }
		});
		await authed.post(`/api/projects/${projectId}/fields`, {
			data: { label: 'Second', type: 'TEXT', sortOrder: 1 }
		});

		const { fields } = await (await authed.get(`/api/projects/${projectId}/fields`)).json();
		expect(fields.map((f: { label: string }) => f.label)).toEqual(['First', 'Second', 'Third']);
	});
});
