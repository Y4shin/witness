import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.member) throw error(401, 'Authentication required');
	if (locals.member.role !== 'MODERATOR') throw error(403, 'Moderator access required');

	const fields = await db.formField.findMany({
		where: { projectId: params.id },
		orderBy: { sortOrder: 'asc' }
	});

	return { projectId: params.id, fields };
};
