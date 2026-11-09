/**
 * A Cordis-shaped fake, so the plugin's own behaviour can be tested without
 * booting a harness.
 *
 * The pieces that matter are the ones the plugin actually leans on: `inject`
 * gating a child on all named services being present, `effect` collecting
 * disposers so teardown can be exercised, `on` capturing waterfall listeners so
 * a decision can be driven by hand, and `get` answering optional lookups. The
 * services themselves are caller-supplied stubs, which keeps each test's
 * expectations about the *contract* rather than about a real registry.
 */

/**
 * Build a fake context.
 *
 * @param services - the services to expose, keyed by name, or a factory that
 *   receives the registration records so a stub can record what it was handed.
 * @returns the context plus the record of everything registered through it.
 */
export function createFakeContext(services = {}) {
	const records = {
		sections: [],
		variables: [],
		tools: [],
		routes: [],
		skills: [],
		contributors: [],
		listeners: new Map(),
		disposers: [],
		warnings: [],
		infos: [],
	}

	if (typeof services === 'function') services = services(records)

	const ctx = {
		records,
		logger: {
			info: (message) => records.infos.push(message),
			warn: (message) => records.warnings.push(message),
		},
		get: (name) => services[name],
		effect(fn) {
			const disposer = fn()
			if (typeof disposer === 'function') records.disposers.push(disposer)
			return disposer
		},
		on(event, listener, options) {
			if (!records.listeners.has(event)) records.listeners.set(event, [])
			const entry = { listener, options }
			if (options?.prepend === true) records.listeners.get(event).unshift(entry)
			else records.listeners.get(event).push(entry)
			return () => {
				const list = records.listeners.get(event) ?? []
				const index = list.indexOf(entry)
				if (index !== -1) list.splice(index, 1)
			}
		},
		inject(names, callback) {
			const scoped = Object.create(ctx)
			for (const name of names) {
				if (services[name] === undefined) return
				scoped[name] = services[name]
			}
			callback(scoped)
		},
		/** Run every collected disposer, newest first — what a fiber teardown does. */
		disposeAll() {
			for (const disposer of [...records.disposers].reverse()) disposer()
			records.disposers.length = 0
		},
	}

	for (const [name, service] of Object.entries(services)) ctx[name] = service
	return ctx
}

/**
 * Drive one waterfall by hand, running the captured listeners in order.
 *
 * @param ctx - the fake context.
 * @param event - the event name.
 * @param args - the arguments before `next`.
 * @param tail - the terminal decision.
 * @returns the settled decision.
 */
export async function runWaterfall(ctx, event, args, tail) {
	const listeners = (ctx.records.listeners.get(event) ?? []).map((entry) => entry.listener)
	const dispatch = async (index) => {
		if (index >= listeners.length) return await tail()
		return await listeners[index](...args, () => dispatch(index + 1))
	}
	return await dispatch(0)
}

/**
 * A stub `ctx.shellEnv` that records contributors and can run their resolvers.
 * @returns the stub.
 */
export function createFakeShellEnv() {
	const contributors = new Map()
	return {
		/** Every currently registered contributor, keyed by name. */
		contributors,
		register(contributor) {
			if (contributors.has(contributor.name)) throw new Error(`duplicate contributor ${contributor.name}`)
			contributors.set(contributor.name, contributor)
			return () => contributors.delete(contributor.name)
		},
		list() {
			return [...contributors.values()].flatMap((contributor) => Object.entries(contributor.variables)
				.map(([key, variable]) => ({ contributor: contributor.name, key, description: variable.description })))
		},
	}
}

/**
 * A stub `ctx.connection` with a fixed fence verdict.
 * @param status - the status to answer with, or undefined to admit.
 * @returns the stub plus the calls it saw.
 */
export function createFakeConnection(status) {
	const calls = []
	return {
		calls,
		requestRejection(request) {
			calls.push(request)
			return status
		},
	}
}

/**
 * A fake HTTP request that emits its body asynchronously.
 * @param options - method, url, headers and body text.
 * @returns the fake request.
 */
export function createFakeRequest(options = {}) {
	const handlers = new Map()
	const request = {
		method: options.method ?? 'GET',
		url: options.url ?? '/',
		headers: options.headers ?? {},
		destroyed: false,
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, [])
			handlers.get(event).push(handler)
			return request
		},
		destroy() {
			request.destroyed = true
		},
	}
	queueMicrotask(() => {
		if (options.rawBody !== undefined) {
			for (const handler of handlers.get('data') ?? []) handler(Buffer.from(options.rawBody, 'utf8'))
		}
		for (const handler of handlers.get('end') ?? []) handler()
	})
	return request
}

/**
 * A fake HTTP response that keeps its status, headers and body.
 * @returns the fake response.
 */
export function createFakeResponse() {
	return {
		statusCode: 0,
		headers: {},
		body: undefined,
		setHeader(name, value) {
			this.headers[name.toLowerCase()] = value
		},
		end(body) {
			this.body = body === undefined ? '' : body.toString('utf8')
		},
		/** The parsed JSON body, or undefined when nothing was written. */
		json() {
			return this.body === undefined || this.body.length === 0 ? undefined : JSON.parse(this.body)
		},
	}
}

/**
 * Run one registered route handler against a fake request/response pair.
 *
 * @param ctx - the fake context.
 * @param options - request options.
 * @returns the fake response.
 */
export async function callRoute(ctx, options) {
	const route = ctx.records.routes.at(-1)
	if (route === undefined) throw new Error('no route registered')
	const response = createFakeResponse()
	await route.handler(createFakeRequest({ url: route.path + (options.path ?? ''), ...options }), response)
	return response
}
