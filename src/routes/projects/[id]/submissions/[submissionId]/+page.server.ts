import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.member) {
		redirect(303, `/auth?projectId=${params.id}&next=/projects/${params.id}/submissions/${params.submissionId}`);
	}

	return {
		projectId: params.id,
		submissionId: params.submissionId,
		role: locals.member.role as 'SUBMITTER' | 'MODERATOR',
		encryptedProjectPrivateKey: locals.member.encryptedProjectPrivateKey ?? null
	};
};
