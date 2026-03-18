import { json } from '@sveltejs/kit';
import { issueChallenge } from '$lib/server/auth';
import { db } from '$lib/server/db';
import type { ChallengeResponse } from '$lib/api-types';

export const GET = async () => {
	const nonce = await issueChallenge(db);
	return json({ nonce } satisfies ChallengeResponse);
};
