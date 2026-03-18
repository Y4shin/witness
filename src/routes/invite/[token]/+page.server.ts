import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { logger } from '$lib/server/logger';

export const load: PageServerLoad = async ({ params }) => {
	const invite = await db.inviteLink.findUnique({ where: { token: params.token } });

	if (!invite) {
		error(404, 'Invite link not found');
	}

	if (invite.expiresAt && invite.expiresAt < new Date()) {
		error(410, 'This invite link has expired.');
	}

	if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
		error(410, 'This invite link has already been used.');
	}

	// Consume the link, then redirect to registration
	await db.inviteLink.update({
		where: { token: params.token },
		data: { usedCount: { increment: 1 } }
	});

	logger.info({ inviteId: invite.id, projectId: invite.projectId }, 'Invite link claimed');

	redirect(303, `/auth?projectId=${invite.projectId}`);
};
