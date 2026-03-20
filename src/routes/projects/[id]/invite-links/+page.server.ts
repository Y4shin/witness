import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.member) redirect(303, `/auth?projectId=${params.id}&next=/projects/${params.id}/invite-links`);
	if (locals.member.role !== 'MODERATOR') throw error(403, 'Only moderators can manage invite links');

	return { projectId: params.id };
};
