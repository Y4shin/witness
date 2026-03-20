import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { db } from '$lib/server/db';

export const load: LayoutServerLoad = async ({ params, locals, url }) => {
	if (!locals.member) redirect(303, `/auth?projectId=${params.id}&next=${encodeURIComponent(url.pathname)}`);
	if (locals.member.projectId !== params.id) throw error(403, 'Not a member of this project');

	const project = await db.project.findUnique({ where: { id: params.id }, select: { name: true } });
	if (!project) throw error(404, 'Project not found');

	return {
		projectId: params.id,
		projectName: project.name,
		role: locals.member.role as 'SUBMITTER' | 'MODERATOR'
	};
};
