import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { tryArchive } from '$lib/server/archive';
import type { ArchiveRequest, ArchiveResponse } from '$lib/api-types';

/**
 * POST /api/archive
 *
 * Proxy endpoint: submits a URL to archive.ph on behalf of the authenticated client.
 * The server never stores the URL — it proxies the request and returns the result.
 * This hides the submitter's IP from archive.ph and keeps the URL out of the DB.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.member) throw error(401, 'Authentication required');

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}

	const { url } = body as ArchiveRequest;
	if (typeof url !== 'string' || !url) throw error(400, 'url is required');

	const archiveUrl = await tryArchive(url);

	return json({ archiveUrl } satisfies ArchiveResponse);
};
