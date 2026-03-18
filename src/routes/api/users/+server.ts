import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { createUser, UserCreationError } from '$lib/server/users';
import { db } from '$lib/server/db';
import type { RegisterResponse } from '$lib/api-types';

export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}

	try {
		const user = await createUser(body as never, db);
		return json({ userId: user.id } satisfies RegisterResponse, { status: 201 });
	} catch (err) {
		if (err instanceof UserCreationError) {
			throw error(err.statusCode, err.message);
		}
		throw err;
	}
};
