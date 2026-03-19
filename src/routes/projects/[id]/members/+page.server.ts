import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) redirect(303, `/auth?next=/projects/${params.id}/members`);

	const membership = await db.membership.findUnique({
		where: { userId_projectId: { userId: locals.user.id, projectId: params.id } }
	});
	if (!membership) throw error(403, 'Not a member of this project');
	if (membership.role !== 'MODERATOR') throw error(403, 'Only moderators can view the members page');

	return {
		projectId: params.id,
		currentUserId: locals.user.id,
		encryptedProjectPrivateKey: membership.encryptedProjectPrivateKey ?? null
	};
};
