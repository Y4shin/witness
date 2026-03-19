import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { logger } from '$lib/server/logger';
import type { GetFieldsResponse, CreateFieldRequest, CreateFieldResponse } from '$lib/api-types';

/**
 * GET /api/projects/[id]/fields
 * Returns all form fields for the project, ordered by sortOrder.
 * Requires the caller to be a member (any role) of the project.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	const membership = await db.membership.findUnique({
		where: { userId_projectId: { userId: locals.user.id, projectId: params.id! } }
	});
	if (!membership) throw error(403, 'Not a member of this project');

	const fields = await db.formField.findMany({
		where: { projectId: params.id },
		orderBy: { sortOrder: 'asc' }
	});

	return json({ fields } satisfies GetFieldsResponse);
};

/**
 * POST /api/projects/[id]/fields
 * Creates a new form field. Requires MODERATOR role.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	const membership = await db.membership.findUnique({
		where: { userId_projectId: { userId: locals.user.id, projectId: params.id! } }
	});
	if (!membership) throw error(403, 'Not a member of this project');
	if (membership.role !== 'MODERATOR') throw error(403, 'Moderator role required');

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}

	const b = body as Record<string, unknown>;

	if (typeof b.label !== 'string' || !b.label.trim()) {
		throw error(400, 'label is required');
	}

	const VALID_TYPES = ['TEXT', 'SELECT', 'FILE'] as const;
	if (!VALID_TYPES.includes(b.type as (typeof VALID_TYPES)[number])) {
		throw error(400, 'type must be TEXT, SELECT, or FILE');
	}

	const type = b.type as CreateFieldRequest['type'];

	// SELECT fields require at least one option
	let optionsJson: string | null = null;
	if (type === 'SELECT') {
		const opts = Array.isArray(b.options) ? (b.options as unknown[]).filter((o) => typeof o === 'string' && o.trim()) : [];
		if (opts.length === 0) throw error(400, 'SELECT fields require at least one option');
		optionsJson = JSON.stringify(opts);
	}

	// Auto-assign sortOrder if not provided
	let sortOrder: number;
	if (typeof b.sortOrder === 'number') {
		sortOrder = b.sortOrder;
	} else {
		const agg = await db.formField.aggregate({
			where: { projectId: params.id },
			_max: { sortOrder: true }
		});
		sortOrder = (agg._max.sortOrder ?? -1) + 1;
	}

	const field = await db.formField.create({
		data: {
			projectId: params.id!,
			label: b.label.trim(),
			type,
			options: optionsJson,
			required: b.required === true,
			sortOrder
		}
	});

	logger.info({ projectId: params.id, userId: locals.user.id, fieldId: field.id }, 'Form field created');

	return json({ field } satisfies CreateFieldResponse, { status: 201 });
};
