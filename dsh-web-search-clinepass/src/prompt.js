/**
 * The instruction pair sent for one search.
 *
 * A gateway-executed search returns prose, not a citation block, so the
 * request has to make the answer machine-readable on its own: the trailing
 * Sources section with one markdown link per line is the contract this
 * provider parses. It is also the honesty contract - the model must list only
 * pages it actually retrieved.
 *
 * @module dsh-web-search-clinepass/prompt
 */

export const SEARCH_SYSTEM_PROMPT = [
	'You are the web search backend of a coding agent. A web search tool is attached to this request and runs server-side.',
	'Always use it before answering; never answer from memory, and never present recalled numbers as retrieved facts.',
	'Search as few times as the question needs: one search is usually enough, and never more than three in one answer.',
	'Report only what the retrieved pages say. Quote prices, dates, names, and figures exactly as found.',
	'Never invent, complete, or guess a URL, and never cite a page you did not retrieve.',
].join(' ');

/**
 * Build the user message for one search.
 * @param query - the query the model-facing tool received.
 * @param instructions - optional deployment guidance appended verbatim.
 * @returns the user message text.
 */
export function buildSearchInstruction(query, instructions) {
	const parts = [
		'Search the web for the following query, then answer it.',
		'',
		'Query: ' + query,
		'',
		'Answer requirements:',
		'1. Search first, then answer directly and densely. Prefer concrete figures, dates, and names over generalities, and use a markdown table when the answer is tabular.',
		'2. End the answer with a line containing exactly Sources: followed by one line per retrieved page, each in exactly this form:',
		'   - [page title](https://full.url)',
		'3. List every page you actually relied on, and only those. If a page failed to load or was not used, leave it out.',
		'4. Answer in the language of the query.',
	];
	const extra = typeof instructions === 'string' ? instructions.trim() : '';
	if (extra.length > 0) parts.push('', extra);
	return parts.join('\n');
}
