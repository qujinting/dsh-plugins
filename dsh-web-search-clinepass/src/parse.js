/**
 * Turning one search answer into the seam's portable citation shape.
 *
 * A provider-executed gateway search returns no structured citation block: the
 * gateway answers in the assistant message and the retrieved URLs live inside
 * the answer text. The provider therefore instructs the model to end its answer
 * with a Sources section, and this module splits that section off and parses
 * both markdown links and bare URLs out of it.
 *
 * @module dsh-web-search-clinepass/parse
 */

/** Markdown link: [title](url). */
const MARKDOWN_LINK = /\[([^\]]*)\]\(\s*(https?:\/\/[^)\s]+)\s*\)/gu;
/** Bare URL, stopping at whitespace, quotes, brackets, and CJK/fullwidth punctuation (but not CJK path text). */
const BARE_URL = /https?:\/\/[^\s<>"'`\u3000-\u303f\uff00-\uffef)\]}]+/gu;
/** Trailing characters that punctuation-heavy prose glues onto a URL. */
const TRAILING = /[.,;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u3001\u300c\u300d\u300e\u300f)\uff09\]}]+$/u;
/** A line whose entire content is a sources/references heading. */
const SOURCES_HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:来源|來源|参考资料|參考資料|参考链接|參考連結|参考网址|引用来源|sources?|references?|citations?)\s*(?::|：)?\s*(?:\*\*|__)?\s*$/iu;

/** Strip trailing prose punctuation and unwrap one URL candidate. */
export function cleanUrl(raw) {
	if (typeof raw !== 'string') return undefined;
	let value = raw.trim();
	while (value.length > 0 && TRAILING.test(value)) value = value.replace(TRAILING, '');
	if (value.length === 0) return undefined;
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
	if (parsed.hostname.length === 0) return undefined;
	return parsed.href;
}

/** Display title for one source: the link label when it is informative, else the hostname. */
function titleFor(url, label) {
	const text = typeof label === 'string' ? label.replace(/\s+/gu, ' ').trim() : '';
	if (text.length > 0 && text !== url && !/^https?:\/\//iu.test(text)) return text;
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

/**
 * Collect citeable sources from free text, markdown links first so their
 * labels become titles, then bare URLs. Duplicates collapse on the normalized
 * URL while keeping the first title seen.
 *
 * @param text - the text to scan.
 * @param options - optional cap on returned sources.
 * @returns sources in order of first appearance.
 */
export function extractSources(text, options = {}) {
	const maxSources = Number.isInteger(options.maxSources) && options.maxSources > 0 ? options.maxSources : Number.MAX_SAFE_INTEGER;
	const sources = [];
	const seen = new Set();
	if (typeof text !== 'string' || text.length === 0) return sources;
	const push = (candidate, label) => {
		const url = cleanUrl(candidate);
		if (url === undefined || seen.has(url)) return;
		seen.add(url);
		const title = titleFor(url, label);
		sources.push(title === undefined ? { url } : { url, title });
	};
	for (const match of text.matchAll(MARKDOWN_LINK)) push(match[2], match[1]);
	for (const match of text.matchAll(BARE_URL)) push(match[0], undefined);
	return sources.slice(0, maxSources);
}

/**
 * Split an answer into its prose and its trailing Sources section.
 *
 * The LAST heading-looking line wins, so a model that also writes an inline
 * 来源 sentence mid-answer does not truncate its own prose.
 *
 * @param text - the assistant message text.
 * @returns the prose, the sources block (empty when no heading was found), and whether a split happened.
 */
export function splitAnswerAndSources(text) {
	if (typeof text !== 'string') return { answer: '', sourcesText: '', split: false };
	const lines = text.split(/\r?\n/u);
	let index = -1;
	for (let i = 0; i < lines.length; i += 1) if (SOURCES_HEADING.test(lines[i])) index = i;
	if (index < 0) return { answer: text, sourcesText: '', split: false };
	return {
		answer: lines.slice(0, index).join('\n'),
		sourcesText: lines.slice(index + 1).join('\n'),
		split: true,
	};
}

/**
 * Parse one assistant message into the provider-neutral result the seam wants.
 *
 * The trailing Sources section is removed from the prose so the model does not
 * read every URL twice (once in the answer text, once in the seam's Sources
 * list). When the model ignored the requested shape, sources fall back to every
 * URL in the whole message and the prose is returned untouched.
 *
 * @param text - the assistant message text.
 * @param options - optional cap on returned sources.
 * @returns the answer prose plus the parsed sources.
 */
export function parseSearchAnswer(text, options = {}) {
	const text_ = typeof text === 'string' ? text : '';
	const { answer, sourcesText, split } = splitAnswerAndSources(text_);
	const fromBlock = sourcesText.length > 0 ? extractSources(sourcesText, options) : [];
	const sources = fromBlock.length > 0 ? fromBlock : extractSources(text_, options);
	const prose = split ? answer.trim() : text_.trim();
	return { content: prose.length > 0 ? prose : text_.trim(), sources };
}
