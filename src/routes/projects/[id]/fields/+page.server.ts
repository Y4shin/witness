import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	const membership = await db.membership.findUnique({
		where: { userId_projectId: { userId: locals.user.id, projectId: params.id } }
	});
	if (!membership) throw error(403, 'Not a member of this project');
	if (membership.role !== 'MODERATOR') throw error(403, 'Moderator access required');

	const fields = await db.formField.findMany({
		where: { projectId: params.id },
		orderBy: { sortOrder: 'asc' }
	});

	return { projectId: params.id, fields };
};
