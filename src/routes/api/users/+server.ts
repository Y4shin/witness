import { error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';

// Registration is now handled by POST /api/memberships.
export const POST: RequestHandler = async () => {
	throw error(404, 'Not found — use POST /api/memberships to register');
};
