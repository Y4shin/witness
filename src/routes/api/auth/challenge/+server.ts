import { json } from '@sveltejs/kit';
import { issueChallenge } from '$lib/server/auth';
import { db } from '$lib/server/db';

export const GET = async () => {
	const nonce = await issueChallenge(db);
	return json({ nonce });
};
