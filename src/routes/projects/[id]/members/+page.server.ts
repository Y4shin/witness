import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.member) redirect(303, `/auth?projectId=${params.id}&next=/projects/${params.id}/members`);
	if (locals.member.role !== 'MODERATOR') throw error(403, 'Only moderators can view the members page');

	return {
		projectId: params.id,
		currentMemberId: locals.member.id,
		encryptedProjectPrivateKey: locals.member.encryptedProjectPrivateKey ?? null
	};
};
