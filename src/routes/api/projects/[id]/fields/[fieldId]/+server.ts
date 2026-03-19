import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { logger } from '$lib/server/logger';
import type { PatchFieldResponse } from '$lib/api-types';

async function requireModerator(userId: string, projectId: string) {
	const membership = await db.membership.findUnique({
		where: { userId_projectId: { userId, projectId } }
	});
	if (!membership) throw error(403, 'Not a member of this project');
	if (membership.role !== 'MODERATOR') throw error(403, 'Moderator role required');
}

async function getField(fieldId: string, projectId: string) {
	const field = await db.formField.findUnique({ where: { id: fieldId } });
	if (!field || field.projectId !== projectId) throw error(404, 'Field not found');
	return field;
}

/**
 * PATCH /api/projects/[id]/fields/[fieldId]
 * Updates the sortOrder of a field. Requires MODERATOR role.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	await requireModerator(locals.user.id, params.id!);

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}

	const b = body as Record<string, unknown>;
	if (typeof b.sortOrder !== 'number') throw error(400, 'sortOrder must be a number');

	await getField(params.fieldId!, params.id!);

	const updated = await db.formField.update({
		where: { id: params.fieldId },
		data: { sortOrder: b.sortOrder }
	});

	logger.info(
		{ projectId: params.id, userId: locals.user.id, fieldId: params.fieldId, sortOrder: b.sortOrder },
		'Form field reordered'
	);

	return json({ field: updated } satisfies PatchFieldResponse);
};

/**
 * DELETE /api/projects/[id]/fields/[fieldId]
 * Deletes a field. Requires MODERATOR role. No minimum-field guard.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	await requireModerator(locals.user.id, params.id!);
	await getField(params.fieldId!, params.id!);

	await db.formField.delete({ where: { id: params.fieldId } });

	logger.info(
		{ projectId: params.id, userId: locals.user.id, fieldId: params.fieldId },
		'Form field deleted'
	);

	return json({ ok: true });
};
