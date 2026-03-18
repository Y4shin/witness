// Load OpenTelemetry before anything else (no-op when OTEL_ENABLED != 'true')
import './instrumentation';

import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { getTextDirection } from '$lib/paraglide/runtime';
import { paraglideMiddleware } from '$lib/paraglide/server';
import { validateSession, SESSION_COOKIE_NAME } from '$lib/server/session';
import { db } from '$lib/server/db';

const handleSession: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE_NAME);
	event.locals.user = await validateSession(token, db);
	return resolve(event);
};

const handleParaglide: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, ({ request, locale }) => {
		event.request = request;
		return resolve(event, {
			transformPageChunk: ({ html }) =>
				html
					.replace('%paraglide.lang%', locale)
					.replace('%paraglide.dir%', getTextDirection(locale))
		});
	});

export const handle: Handle = sequence(handleSession, handleParaglide);
