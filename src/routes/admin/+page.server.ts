import { error, fail, redirect } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { logger } from '$lib/server/logger';
import { ADMIN_COOKIE_NAME, revokeAdminSession } from '$lib/server/admin-auth';

export const load: PageServerLoad = async () => {
	const projects = await db.project.findMany({
		orderBy: { createdAt: 'desc' },
		include: { inviteLinks: { where: { createdBy: null }, orderBy: { createdAt: 'desc' } } }
	});
	return { projects };
};

export const actions: Actions = {
	createProject: async ({ request, url }) => {
		const data = await request.formData();
		const name = (data.get('name') as string | null)?.trim();

		if (!name) {
			return fail(400, { createError: 'Project name is required' });
		}

		const project = await db.project.create({ data: { name } });

		// Create a single-use admin-generated MODERATOR invite link
		const token = randomBytes(32).toString('base64url');
		await db.inviteLink.create({
			data: {
				token,
				projectId: project.id,
				role: 'MODERATOR',
				maxUses: 1
			}
		});

		const inviteUrl = `${url.origin}/invite/${token}`;
		logger.info({ projectId: project.id }, 'Admin created project');

		return { created: { projectId: project.id, name: project.name, inviteUrl } };
	},

	deleteProject: async ({ request }) => {
		const data = await request.formData();
		const id = data.get('id') as string | null;

		if (!id) {
			return fail(400, { deleteError: 'Project id is required' });
		}

		try {
			await db.project.delete({ where: { id } });
		} catch {
			error(404, 'Project not found');
		}

		logger.info({ projectId: id }, 'Admin deleted project');
		return { deleted: id };
	},

	logout: async ({ cookies }) => {
		const token = cookies.get(ADMIN_COOKIE_NAME);
		if (token) revokeAdminSession(token);
		cookies.delete(ADMIN_COOKIE_NAME, { path: '/admin' });
		redirect(303, '/admin/login');
	}
};
