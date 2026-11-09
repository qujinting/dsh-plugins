/**
 * The last line of defence: a value that reaches a tool result is replaced
 * before anyone sees it.
 *
 * Injection filtering stops the *accidental bulk* leak (an environment dump, a
 * child process that reports its own env). It cannot stop the single-value
 * leak: a command that echoes `$env:DSH_SECRET_TOKEN` on purpose, a script that
 * prints its own configuration, a compiler that quotes the token back in an
 * error message. `tools/post-execute` is the one seam that can still fix that,
 * because it runs *before* the result is committed to the session log — so the
 * replacement lands in the transcript, the log, and everything derived from
 * them, rather than only in what the model happens to be shown.
 *
 * The scan is deliberately conservative:
 *
 * - values shorter than a threshold are not scanned (a four-character secret
 *   would redact half the alphabet);
 * - the longest value is tried first, so a value containing another value is
 *   replaced as a whole;
 * - only text blocks are touched, and only when something actually matches, so
 *   the common case costs one `includes` per value over the result text.
 *
 * `tools/ptc-dispatch-log` gets the same treatment because a `run_code`
 * sub-dispatch is logged durably through that waterfall, and a leak there would
 * be just as permanent.
 *
 * @module dsh-secret-broker/redact
 */

/** The replacement, naming the key so the model can reason about what happened. */
export function redactionLabel(key) {
	return `«redacted:${key}»`
}

/**
 * Replace every known value in one string.
 *
 * @param text - the text to scan.
 * @param pairs - `[value, key]` pairs, longest first.
 * @returns the redacted text, or undefined when nothing matched.
 */
export function redactText(text, pairs) {
	let out = text
	let changed = false
	for (const [value, key] of pairs) {
		if (value.length === 0 || !out.includes(value)) continue
		out = out.split(value).join(redactionLabel(key))
		changed = true
	}
	return changed ? out : undefined
}

/**
 * Redact one content-block array.
 *
 * Blocks arrive frozen, so a match produces fresh objects and everything else
 * is passed through by reference.
 *
 * @param content - the content blocks.
 * @param pairs - `[value, key]` pairs, longest first.
 * @returns a new array when something was redacted, otherwise undefined.
 */
export function redactContent(content, pairs) {
	if (!Array.isArray(content) || content.length === 0 || pairs.length === 0) return undefined
	let changed = false
	const blocks = content.map((block) => {
		if (block === null || typeof block !== 'object' || block.type !== 'text') return block
		if (typeof block.text !== 'string' || block.text.length === 0) return block
		const redacted = redactText(block.text, pairs)
		if (redacted === undefined) return block
		changed = true
		return { ...block, text: redacted }
	})
	return changed ? blocks : undefined
}

/**
 * Install both result-redaction listeners.
 *
 * @param ctx - the plugin context; `ctx.on` scopes the listeners to its fiber.
 * @param store - the secret store.
 * @param options - resolved plugin options.
 * @param options.redactResults - whether redaction is on at all.
 * @param options.redactMinLength - shortest value worth scanning for.
 * @returns a disposer that removes both listeners.
 */
export function installRedaction(ctx, store, options) {
	/**
	 * The values worth scanning for one execution's session.
	 * @param execution - the tool execution, when the waterfall has one.
	 * @returns the pairs, longest value first.
	 */
	const pairsFor = (execution) => {
		if (!options.redactResults) return []
		const header = execution?.agent?.session?.header
		return store.redactionPairs(header?.id, header?.cwd).filter(([value]) => value.length >= options.redactMinLength)
	}

	const offPost = ctx.on('tools/post-execute', async (exec, result, next) => {
		const decision = await next()
		if (decision === null || typeof decision !== 'object' || decision.kind !== 'accept') return decision
		// A `value` replacement hands the result back to its own output schema;
		// rewriting the content of that is the tool's business, not ours.
		if (Object.hasOwn(decision, 'value')) return decision
		const pairs = pairsFor(exec)
		if (pairs.length === 0) return decision
		const content = Array.isArray(decision.content) ? decision.content : result?.content
		const redacted = redactContent(content, pairs)
		return redacted === undefined ? decision : { ...decision, content: redacted }
	})

	const offPtc = ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
		const content = await next()
		const pairs = pairsFor(dispatch?.exec)
		if (pairs.length === 0) return content
		return redactContent(content, pairs) ?? content
	})

	return () => {
		offPost?.()
		offPtc?.()
	}
}
