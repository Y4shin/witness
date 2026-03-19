import { logger } from '$lib/server/logger';

/**
 * Submits a URL to archive.ph for archiving.
 * Returns the archive URL on success, or null if archiving fails or is unavailable.
 * This is intentionally fire-and-forget friendly — errors are logged but not thrown.
 */
export async function tryArchive(url: string): Promise<string | null> {
	try {
		const body = new URLSearchParams({ url, anyway: '1' });
		const res = await fetch('https://archive.ph/submit/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body,
			redirect: 'manual',
			// Timeout after 15 seconds
			signal: AbortSignal.timeout(15_000)
		});

		// archive.ph returns a 302 redirect to the archive URL
		const location = res.headers.get('location');
		if (location) {
			logger.info({ url, archiveUrl: location }, 'Archive created');
			return location;
		}

		logger.warn({ url, status: res.status }, 'Archive.ph did not return a redirect');
		return null;
	} catch (err) {
		logger.warn({ url, err }, 'Failed to archive URL');
		return null;
	}
}
