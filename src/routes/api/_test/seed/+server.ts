/**
 * Test-only seed endpoint. Disabled in production (TEST_MODE != 'true').
 * Supports seeding users and projects with known state.
 * Used by Playwright tests to set up test scenarios without a UI.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';

export const POST: RequestHandler = async ({ request }) => {
	if (process.env.TEST_MODE !== 'true') {
		throw error(404, 'Not found');
	}

	const body = await request.json().catch(() => null);
	if (!body || typeof body.type !== 'string') {
		throw error(400, 'type is required');
	}

	if (body.type === 'user') {
		if (typeof body.signingPublicKey !== 'string' || typeof body.encryptionPublicKey !== 'string') {
			throw error(400, 'signingPublicKey and encryptionPublicKey are required');
		}
		const user = await db.user.create({
			data: {
				signingPublicKey: body.signingPublicKey,
				encryptionPublicKey: body.encryptionPublicKey,
				encryptedName: body.encryptedName ?? 'test-enc-name',
				encryptedContact: body.encryptedContact ?? 'test-enc-contact'
			}
		});
		return json({ userId: user.id });
	}

	if (body.type === 'project') {
		if (typeof body.name !== 'string') {
			throw error(400, 'name is required');
		}
		const project = await db.project.create({
			data: {
				name: body.name,
				publicKey: body.publicKey ?? null
			}
		});
		return json({ projectId: project.id });
	}

	throw error(400, `Unknown type: ${body.type}`);
};
