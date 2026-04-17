import { json } from '@sveltejs/kit';
import { injectPrompt } from '$lib/server/ralph';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const result = await injectPrompt(String(body.name || ''), String(body.prompt || ''));

	return json(result, { status: result.success ? 200 : 400 });
};
