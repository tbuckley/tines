import type { ParamMatcher } from '@sveltejs/kit';

/**
 * Keeps the catch-all 404 page off /api/*. Without it the rest parameter would
 * swallow unknown API paths, and the (app) layout's auth redirect would answer
 * a bad API request with a 302 to the sign-in page instead of a 404.
 */
export const match: ParamMatcher = (param) => param !== 'api' && !param.startsWith('api/');
