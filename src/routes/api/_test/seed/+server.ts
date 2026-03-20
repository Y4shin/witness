/**
 * Test-only seed endpoint. Disabled in production (TEST_MODE != 'true').
 * Supports seeding members and projects with known state.
 * Used by Playwright tests to set up test scenarios without a UI.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';

export const POST: RequestHandler = async ({ request }) => {
	if (env.TEST_MODE !== 'true') {
		throw error(404, 'Not found');
	}

	const body = await request.json().catch(() => null);
	if (!body || typeof body.type !== 'string') {
		throw error(400, 'type is required');
	}

	if (body.type === 'member') {
		if (typeof body.projectId !== 'string') throw error(400, 'projectId is required');
		if (typeof body.signingPublicKey !== 'string' || typeof body.encryptionPublicKey !== 'string') {
			throw error(400, 'signingPublicKey and encryptionPublicKey are required');
		}
		// Normalize JWK strings to canonical (sorted-key) form so they match what the browser produces
		const canonicalize = (s: string) =>
			JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(s) as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))));
		const role = body.role === 'SUBMITTER' ? 'SUBMITTER' : 'MODERATOR';
		const member = await db.member.create({
			data: {
				projectId: body.projectId,
				signingPublicKey: canonicalize(body.signingPublicKey),
				encryptionPublicKey: canonicalize(body.encryptionPublicKey),
				encryptedName: body.encryptedName ?? 'test-enc-name',
				encryptedContact: body.encryptedContact ?? 'test-enc-contact',
				role,
				encryptedProjectPrivateKey:
					typeof body.encryptedProjectPrivateKey === 'string'
						? body.encryptedProjectPrivateKey
						: null
			}
		});
		return json({ memberId: member.id, projectId: member.projectId, role: member.role });
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

	if (body.type === 'inviteLink') {
		if (typeof body.projectId !== 'string') {
			throw error(400, 'projectId is required');
		}
		const invite = await db.inviteLink.create({
			data: {
				token: body.token ?? crypto.randomUUID(),
				projectId: body.projectId,
				role: body.role ?? 'MODERATOR',
				maxUses: body.maxUses ?? 1,
				usedCount: body.usedCount ?? 0,
				// Accept an ISO-8601 string so tests can create expired links (past dates)
				expiresAt: body.expiresAt ? new Date(body.expiresAt) : null
			}
		});
		return json({ inviteId: invite.id, token: invite.token });
	}

	if (body.type === 'submission') {
		if (typeof body.projectId !== 'string') throw error(400, 'projectId is required');
		if (typeof body.memberId !== 'string') throw error(400, 'memberId is required');
		const submission = await db.submission.create({
			data: {
				projectId: body.projectId,
				memberId: body.memberId,
				encryptedPayload: body.encryptedPayload ?? 'test-payload',
				encryptedKeyProject: body.encryptedKeyProject ?? '{}',
				encryptedKeyUser: body.encryptedKeyUser ?? '{}',
				submitterSignature: body.submitterSignature ?? 'test-sig'
			}
		});
		return json({ submissionId: submission.id });
	}

	throw error(400, `Unknown type: ${body.type}`);
};
