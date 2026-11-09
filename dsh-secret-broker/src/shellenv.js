/**
 * How a key becomes an environment variable in a model shell call.
 *
 * `ctx.shellEnv` is the harness's own extension point for "trusted,
 * per-execution `DSH_*` variables" — the registry that `dsh-tool-pwsh` and
 * `dsh-tool-bash` consult and whose result `dsh-pwsh-local` merges into the
 * child's `env`. Using it means the value never has to appear in a command
 * line, a tool argument, or a tool result: the model writes
 * `$env:DSH_SECRET_GH_TOKEN`, the host substitutes the value at spawn time.
 *
 * Two filters decide *which* secrets one execution receives, and both exist to
 * turn "the model could leak everything by accident" into "the model must name
 * what it wants":
 *
 * - **Scope.** Globals apply everywhere; `session:<id>` entries apply only to
 *   that session and shadow a global of the same key. A subagent has its own
 *   session id and therefore does not inherit its parent's session secrets.
 * - **Mention.** An entry is injected only when the command text names its
 *   variable — or when the command carries an explicit
 *   `# secret-broker: KEY1, KEY2` marker, which is how a script invoked by path
 *   opts in without spelling the variable out. `Get-ChildItem env:` and
 *   `npm run` therefore inherit nothing.
 *
 * The declaration set is the union over every scope, not the computed subset:
 * `ctx.shellEnv.register` fixes a contributor's variable names at registration
 * time, while the value set is decided per execution. Declaring a superset and
 * resolving a subset is exactly the registry's contract, and it is why the
 * store re-registers the contributor whenever the key set changes.
 *
 * @module dsh-secret-broker/shellenv
 */

/** Contributor name; unique in the registry, and the name in its diagnostics. */
export const CONTRIBUTOR_NAME = 'secret-broker'

/**
 * The opt-in comment a command can carry: `# secret-broker: A, B` or
 * `# secret-broker: all`. Deliberately plain so it survives every shell quoting
 * style unchanged.
 */
const MARKER_PATTERN = /#\s*secret-broker\s*:\s*([^\r\n]*)/gi

/**
 * Read every marker in one command.
 *
 * @param command - the command text.
 * @returns whether `all` was asked for, and the lower-cased key names named.
 */
export function parseMarkers(command) {
	const keys = new Set()
	let all = false
	for (const match of String(command).matchAll(MARKER_PATTERN)) {
		for (const token of match[1].split(/[,，\s]+/)) {
			const name = token.trim()
			if (name.length === 0) continue
			if (name.toLowerCase() === 'all') all = true
			else keys.add(name.toLowerCase())
		}
	}
	return { all, keys }
}

/**
 * Whether a command names one variable.
 * @param command - the command text.
 * @param env - the variable name.
 * @returns whether the name occurs, case-insensitively.
 */
export function mentionsVariable(command, env) {
	return command.toLowerCase().includes(env.toLowerCase())
}

/**
 * Decide the environment overlay for one tool execution.
 *
 * @param store - the secret store.
 * @param execution - the tool execution handed to `resolve`.
 * @returns the variables to inject; an empty object for anything that is not a
 *   shell call, and for every entry the command did not name.
 */
export function resolveEnvironment(store, execution) {
	const command = execution?.arguments?.command
	if (typeof command !== 'string' || command.length === 0) return {}
	// Both halves of the scope decision come from the session: which project it
	// is working in, and which session it is.
	const header = execution?.agent?.session?.header
	const entries = store.effective(header?.id, header?.cwd)
	if (entries.length === 0) return {}
	const markers = parseMarkers(command)
	const values = {}
	for (const entry of entries) {
		const wanted = markers.all
			|| markers.keys.has(entry.key.toLowerCase())
			|| mentionsVariable(command, entry.env)
		if (wanted) values[entry.env] = entry.value
	}
	return values
}

/**
 * Keep one `ctx.shellEnv` contributor in step with the store.
 *
 * The registry validates a contributor's declared names once, so a key added in
 * the settings page only reaches shell calls after the contributor is replaced.
 * That replacement is the whole reason this is a small stateful object rather
 * than a single `register` call.
 */
export class ShellEnvBridge {
	/**
	 * @param shellEnv - the `ctx.shellEnv` service.
	 * @param store - the secret store.
	 */
	constructor(shellEnv, store) {
		this.shellEnv = shellEnv
		this.store = store
		this.dispose = undefined
	}

	/**
	 * Register the contributor with the store's current declaration set.
	 * @returns whether registration succeeded.
	 */
	sync() {
		try {
			this.dispose?.()
			this.dispose = this.shellEnv.register({
				name: CONTRIBUTOR_NAME,
				variables: this.store.declarations(),
				resolve: (execution) => resolveEnvironment(this.store, execution),
			})
			return true
		} catch (error) {
			this.dispose = undefined
			this.store.logger?.warn?.(`secret-broker: 注册 shell 环境变量失败：${error?.message ?? error}`)
			return false
		}
	}

	/** Release the contributor, if one is registered. */
	release() {
		try {
			this.dispose?.()
		} catch {
			/* the registry is already gone */
		}
		this.dispose = undefined
	}
}
