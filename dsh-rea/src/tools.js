/**
 * The two model-facing tools: search REA's catalog, then run one tool.
 *
 * REA publishes 229 tools. Registering them all is what the shipped MCP bridge
 * does and what makes a session slow: every request carries every schema. The
 * gateway shape below keeps the whole catalog reachable while paying for two
 * schemas, and the catalog itself is discovered from the server rather than
 * hard-coded here, so a REA upgrade changes nothing in this plugin.
 *
 * @module dsh-rea/tools
 */

/** Default number of catalog rows one search returns. */
const DEFAULT_LIMIT = 15

/** Hard ceiling, so a wide query cannot flood a request. */
const MAX_LIMIT = 60

/** Longest description kept per row, in characters. */
const DESCRIPTION_CHARS = 220

/** Longest schema text returned inline, in characters. */
const SCHEMA_CHARS = 12_000

/**
 * Build the `rea_tools` catalog tool.
 *
 * @param options - resolved plugin options.
 * @param client - the MCP client that owns the live catalog.
 * @param onActivity - called after a successful call so idle shutdown can reset.
 * @returns the tool definition accepted by `ctx.tools.register`.
 */
export function reaToolsTool(options, client, onActivity) {
	return {
		name: options.toolsToolName,
		description: [
			`Search REA's reverse-engineering tool catalog and return exact tool names with the JSON input schema \`${options.callToolName}\` requires.`,
			'Call this first for any reverse-engineering task: it is the only way to learn which REA tool fits, and every name it returns is callable.',
			'Pass `query` for a keyword search over names, titles, and descriptions; pass `exact` with a tool name to get that tool\'s complete input schema; pass `schemas` to include schemas for every match.',
			'Tasks this is for: explaining what a binary, app bundle, Electron app, web bundle, firmware image, APK, or captured traffic actually does; decompiling or debugging; tracing a live runtime; comparing versions; reconstructing an application from its shipped artifacts.',
		].join(' '),
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				query: {
					type: 'string',
					description: 'Keywords matched against tool name, title, and description, for example "decompile", "apk signature", "trace web", "firmware".',
				},
				exact: {
					type: 'string',
					description: 'Exact tool name from an earlier result; returns that tool alone with its complete input schema.',
				},
				limit: {
					type: 'integer',
					description: `Maximum rows to return. Default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}.`,
				},
				schemas: {
					type: 'boolean',
					description: 'Include each match\'s input schema. Useful before a call with non-obvious arguments; it also makes the result much longer.',
				},
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					total: { type: 'integer' },
					matchCount: { type: 'integer' },
					rows: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								name: { type: 'string' },
								title: { type: 'string' },
								description: { type: 'string' },
								required: { type: 'array', items: { type: 'string' } },
								inputSchema: { type: 'string' },
							},
							required: ['name'],
						},
					},
					note: { type: 'string' },
				},
				required: ['total', 'matchCount', 'rows'],
			},
			render: (_args, value) => {
				const lines = [`<rea-catalog total="${value.total}" matches="${value.matchCount}">`]
				for (const row of value.rows) {
					const required = row.required.length === 0 ? 'no required arguments' : `required: ${row.required.join(', ')}`
					lines.push(`- ${row.name} — ${row.title ?? ''}`.trimEnd())
					lines.push(`    ${row.description ?? ''}`)
					lines.push(`    ${required}`)
					if (row.inputSchema !== undefined) {
						lines.push('    input schema:', '```json', row.inputSchema, '```')
					}
				}
				if (value.note !== undefined && value.note.length > 0) lines.push(value.note)
				lines.push('</rea-catalog>')
				return [{ type: 'text', text: lines.join('\n') }]
			},
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			try {
				const catalog = await client.start()
				const rows = Array.isArray(catalog) ? catalog : []
				const limit = clampLimit(args.limit)
				const wantSchemas = args.schemas === true
				const exact = typeof args.exact === 'string' ? args.exact.trim() : ''

				if (exact.length > 0) {
					const tool = rows.find((entry) => entry.name === exact)
						?? rows.find((entry) => entry.name.toLowerCase() === exact.toLowerCase())
					if (tool === undefined) {
						throw new Error(`dsh-rea: no REA tool named "${exact}". Call ${options.toolsToolName} with a query to find the right name.`)
					}
					return {
						total: rows.length,
						matchCount: 1,
						rows: [projectRow(tool, true)],
					}
				}

				const query = typeof args.query === 'string' ? args.query.trim() : ''
				const scored = query.length === 0
					? rows.map((tool) => ({ tool, score: 0 }))
					: rank(rows, query)
				const chosen = scored.slice(0, limit).map(({ tool }) => projectRow(tool, wantSchemas))
				return {
					total: rows.length,
					matchCount: scored.length,
					rows: chosen,
					...(query.length === 0
						? { note: `No query given: showing the first ${chosen.length} of ${rows.length} tools. Pass \`query\` to search, or \`exact\` for one tool's schema.` }
						: scored.length > chosen.length
							? { note: `${scored.length} tools matched; showing ${chosen.length}. Narrow the query or raise \`limit\`.` }
							: {}),
				}
			} finally {
				// Count the attempt, not just the success: a launch that failed must
				// still arm the idle stop, or its half-started child lives until unload.
				onActivity()
			}
		},
	}
}

/**
 * Build the `rea_call` dispatcher tool.
 *
 * @param options - resolved plugin options.
 * @param client - the MCP client that owns the live catalog.
 * @param onActivity - called after a successful call so idle shutdown can reset.
 * @returns the tool definition accepted by `ctx.tools.register`.
 */
export function reaCallTool(options, client, onActivity) {
	return {
		name: options.callToolName,
		description: [
			'Run one REA reverse-engineering tool against a real target and return its result as text.',
			`Pass the exact tool name from \`${options.toolsToolName}\` and its arguments object; a name this session has not discovered is rejected instead of guessed.`,
			'REA works on absolute paths and on live runtimes, so give it the real artifact path, package id, or capture file. Results are the model\'s only evidence: quote measured values, not expectations.',
			'Some tools take minutes (decompiling, provider startup, runtime tracing); they are not hung. Prefer one well-aimed call over a fan of exploratory ones.',
		].join(' '),
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				tool: {
					type: 'string',
					description: `Exact REA tool name, as returned by ${options.toolsToolName}.`,
				},
				arguments: {
					type: 'object',
					additionalProperties: true,
					description: 'Arguments object for that tool, matching the input schema the catalog returned. Omit it for tools that take none.',
				},
			},
			required: ['tool'],
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tool: { type: 'string' },
					text: { type: 'string' },
					imageCount: { type: 'integer' },
				},
				required: ['tool', 'text'],
			},
			render: (_args, value) => {
				const lines = [`<rea-result tool="${value.tool}">`, value.text, '</rea-result>']
				if (value.imageCount > 0) {
					lines.push(`REA also returned ${value.imageCount} image block(s); this gateway forwards text only.`)
				}
				return [{ type: 'text', text: lines.join('\n') }]
			},
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			try {
				const name = typeof args.tool === 'string' ? args.tool.trim() : ''
				if (name.length === 0) throw new Error(`dsh-rea: \`tool\` must be a non-empty string; call ${options.toolsToolName} to find a name`)
				const catalog = await client.start()
				if (!catalog.some((entry) => entry.name === name)) {
					throw new Error(`dsh-rea: "${name}" is not a REA tool in the running catalog. Call ${options.toolsToolName} with a query first.`)
				}
				const toolArguments = args.arguments !== null && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
					? args.arguments
					: {}
				const result = await client.call(name, toolArguments, exec.signal)
				const blocks = Array.isArray(result?.content) ? result.content : []
				const text = blocks
					.filter((block) => block.type === 'text' && typeof block.text === 'string')
					.map((block) => block.text)
					.join('\n')
				const imageCount = blocks.filter((block) => block.type === 'image').length
				const structured = text.length === 0 && result?.structuredContent !== undefined
					? JSON.stringify(result.structuredContent, null, 1)
					: text
				if (result?.isError === true) {
					throw new Error(structured.length > 0 ? structured : `dsh-rea: ${name} reported an error without a message`)
				}
				return { tool: name, text: structured, imageCount }
			} finally {
				onActivity()
			}
		},
	}
}

/**
 * Score catalog entries against a keyword query.
 * @param rows - the discovered catalog.
 * @param query - the raw query text.
 * @returns entries sorted by descending relevance.
 */
function rank(rows, query) {
	const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0)
	const scored = []
	for (const tool of rows) {
		const name = String(tool.name ?? '').toLowerCase()
		const title = String(tool.title ?? '').toLowerCase()
		const description = String(tool.description ?? '').toLowerCase()
		let score = 0
		for (const term of terms) {
			if (name === term) score += 12
			else if (name.includes(term)) score += 6
			if (title.includes(term)) score += 3
			if (description.includes(term)) score += 1
		}
		if (score > 0) scored.push({ tool, score })
	}
	scored.sort((left, right) => right.score - left.score || String(left.tool.name).localeCompare(String(right.tool.name)))
	return scored
}

/**
 * Project one catalog entry into the tool's output shape.
 * @param tool - the raw MCP tool entry.
 * @param withSchema - whether to inline its input schema.
 * @returns the projected row.
 */
function projectRow(tool, withSchema) {
	const description = String(tool.description ?? '').replace(/\s+/g, ' ').trim()
	const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required.filter((key) => typeof key === 'string') : []
	const row = {
		name: String(tool.name),
		...(typeof tool.title === 'string' ? { title: tool.title } : {}),
		description: description.length > DESCRIPTION_CHARS ? `${description.slice(0, DESCRIPTION_CHARS)}…` : description,
		required,
	}
	if (withSchema) {
		let schema = JSON.stringify(tool.inputSchema ?? {}, null, 1)
		if (schema.length > SCHEMA_CHARS) schema = `${schema.slice(0, SCHEMA_CHARS)}\n… schema truncated; the tool accepts additional properties not shown here`
		row.inputSchema = schema
	}
	return row
}

/**
 * Read the requested row limit.
 * @param value - the raw `limit` argument.
 * @returns a usable limit between 1 and MAX_LIMIT.
 */
function clampLimit(value) {
	if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_LIMIT
	return Math.min(value, MAX_LIMIT)
}
