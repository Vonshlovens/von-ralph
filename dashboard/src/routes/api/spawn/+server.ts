import { json } from '@sveltejs/kit';
import { spawnRalph } from '$lib/server/ralph';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

	const result = await spawnRalph({
		prompt: body.prompt,
		maxRuns: body.maxRuns,
		name: body.name,
		dir: body.dir,
		model: body.model,
		marathon: body.marathon
	});

	return json({ success: true, ...result });
};
