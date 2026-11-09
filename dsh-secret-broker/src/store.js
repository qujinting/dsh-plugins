/**
 * The encrypted key/value store behind the broker.
 *
 * One file holds every entry, sealed with DPAPI for the current Windows user,
 * and the whole document is in memory after `ready` resolves. That shape is
 * forced by two callers with different timing needs: the settings page wants an
 * async, validating, transactional API, while the shell-environment contributor
 * must answer *synchronously* during a tool call — so the in-memory snapshot is
 * the source of truth for injection and disk is the source of truth across
 * restarts.
 *
 * Four decisions are worth stating because they are the ones that keep a bug
 * from costing the user their secrets:
 *
 * 1. **An unreadable store locks, it never overwrites.** If a blob exists and
 *    cannot be opened, the store publishes zero entries, reports `locked`, and
 *    refuses every write. A DPAPI failure after a Windows profile change is
 *    then a visible error instead of a silent erase.
 * 2. **A write is a locked read-modify-write with a backup.** Two DSH processes
 *    can both serve the settings page, so a `.lock` file serializes them, the
 *    previous blob is copied to `.bak`, and the new bytes land through
 *    `rename` so no reader ever sees a half-written document.
 * 3. **Scope is part of an entry's identity.** `global` applies to every
 *    session; `session:<id>` applies to exactly one. A session entry shadows a
 *    global one with the same key, which is what makes "this project's token
 *    overrides my default token" work without a second name.
 * 4. **Validation is at the boundary, not in the UI.** Key grammar, env-name
 *    grammar, and per-scope env collisions are enforced here, so the HTTP route
 *    and the client half cannot disagree about what a legal entry is.
 *
 * @module dsh-secret-broker/store
 */

import fs from 'node:fs'
import path from 'node:path'
import { MAX_SECRET_BYTES } from './crypto.js'

/** The one scope name that is not a session or a project. */
export const GLOBAL_SCOPE = 'global'

/** Scope prefixes. */
const SESSION_PREFIX = 'session:'
const PROJECT_PREFIX = 'project:'

/** Keys are shell-identifier shaped; `.` is excluded so normalization is injective. */
export const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

/** The document version this store writes. */
const DOCUMENT_VERSION = 1

/** File names inside the data directory. */
const SEALED_FILE = 'secrets.dpapi'
const PLAIN_FILE = 'secrets.json'
const BACKUP_SUFFIX = '.bak'
const LOCK_FILE = '.lock'

/** A lock older than this is treated as a crashed writer's and stolen. */
const LOCK_STALE_MS = 15_000

/** How many times a contended write waits for the lock before giving up. */
const LOCK_ATTEMPTS = 40
const LOCK_RETRY_MS = 25

/**
 * Build the scope name for one session.
 * @param sessionId - the session id.
 * @returns the scope string stored on an entry.
 */
export function sessionScope(sessionId) {
	return `session:${String(sessionId)}`
}

/**
 * Build the scope name for one project directory.
 *
 * A project is a working directory, not a session: the same token belongs to
 * every session opened in that directory, and survives all of them. The path is
 * resolved and stripped of a trailing separator so two spellings of one
 * directory cannot become two scopes.
 *
 * @param directory - an absolute directory path.
 * @returns the scope string stored on an entry, or undefined when it is not a usable path.
 */
export function projectScope(directory) {
	const raw = typeof directory === 'string' ? directory.trim() : ''
	if (raw.length === 0) return undefined
	let resolved
	try {
		resolved = path.resolve(raw)
	} catch {
		return undefined
	}
	// `path.resolve('C:\\')` keeps its separator; nothing else should.
	const trimmed = resolved.length > 3 ? resolved.replace(/[\\/]+$/u, '') : resolved
	return `${PROJECT_PREFIX}${trimmed}`
}

/**
 * The directory a project scope names.
 * @param scope - the scope string.
 * @returns the path, or undefined when it is not a project scope.
 */
export function projectDirectory(scope) {
	const parsed = parseScope(scope)
	return parsed?.kind === 'project' ? parsed.directory : undefined
}

/**
 * Compare two paths the way the platform does.
 * @param left - one path.
 * @param right - the other.
 * @returns whether they name the same directory.
 */
function samePath(left, right) {
	return process.platform === 'win32'
		? left.toLowerCase() === right.toLowerCase()
		: left === right
}

/**
 * Whether one path is the other or lives beneath it.
 * @param parent - the candidate ancestor.
 * @param child - the candidate descendant.
 * @returns whether `child` is `parent` or inside it.
 */
export function pathContains(parent, child) {
	if (samePath(parent, child)) return true
	const separator = parent.endsWith('/') || parent.endsWith('\\') ? '' : path.sep
	const prefix = parent + separator
	return process.platform === 'win32'
		? child.toLowerCase().startsWith(prefix.toLowerCase())
		: child.startsWith(prefix)
}

/**
 * Classify a scope string.
 * @param scope - the raw scope.
 * @returns a descriptor for `global`, `project` or `session`, or undefined when it is none of them.
 */
export function parseScope(scope) {
	const raw = typeof scope === 'string' ? scope.trim() : scope
	if (raw === GLOBAL_SCOPE) return { kind: 'global' }
	if (typeof raw !== 'string') return undefined
	if (raw.startsWith(PROJECT_PREFIX)) {
		const directory = raw.slice(PROJECT_PREFIX.length).trim()
		return directory.length === 0 ? undefined : { kind: 'project', directory }
	}
	if (!raw.startsWith(SESSION_PREFIX)) return undefined
	const sessionId = raw.slice(SESSION_PREFIX.length).trim()
	if (sessionId.length === 0) return undefined
	return { kind: 'session', sessionId }
}

/**
 * Normalize a scope string to its stored form.
 *
 * `parseScope` accepts surrounding whitespace so the HTTP boundary can be
 * forgiving, but an entry's identity is compared against `sessionScope(id)` and
 * `projectScope(dir)` during injection — so what gets stored has to be exactly
 * that canonical form.
 *
 * @param scope - the raw scope.
 * @returns the canonical scope, or undefined when it is none of the three shapes.
 */
export function canonicalScope(scope) {
	const parsed = parseScope(scope)
	if (parsed === undefined) return undefined
	if (parsed.kind === 'global') return GLOBAL_SCOPE
	if (parsed.kind === 'project') return projectScope(parsed.directory)
	return sessionScope(parsed.sessionId)
}

/**
 * Human label for a scope, used in declarations, tool output and the GUI.
 * @param scope - the scope string.
 * @returns a short label.
 */
export function scopeLabel(scope) {
	const parsed = parseScope(scope)
	if (parsed === undefined) return String(scope)
	if (parsed.kind === 'global') return '全局'
	if (parsed.kind === 'project') return `工程 ${path.basename(parsed.directory) || parsed.directory}`
	return `会话 ${parsed.sessionId.slice(0, 12)}`
}

/**
 * Whether two scopes can apply to one and the same execution.
 *
 * This is what decides if two different keys may fold onto one variable name:
 * they may not, if a single session could see both. Sibling projects never
 * overlap, a project and its own subdirectory do, and a session scope overlaps
 * every project scope because that session may well be working in one.
 *
 * @param left - one canonical scope.
 * @param right - the other canonical scope.
 * @returns whether they can apply together.
 */
export function scopesOverlap(left, right) {
	if (left === right) return true
	const a = parseScope(left)
	const b = parseScope(right)
	if (a === undefined || b === undefined) return false
	if (a.kind === 'global' || b.kind === 'global') return true
	if (a.kind === 'project' && b.kind === 'project') {
		return pathContains(a.directory, b.directory) || pathContains(b.directory, a.directory)
	}
	// A session scope can sit in any project, so it overlaps all of them.
	if (a.kind === 'session' && b.kind === 'session') return false
	return true
}

/**
 * Order two scopes by specificity, so the more specific one wins.
 *
 * `session` beats `project` beats `global`, and a deeper project beats a
 * shallower one — which is what makes "this repo's token, except in that
 * subpackage" expressible.
 *
 * @param scope - the scope to rank.
 * @returns a comparable rank; larger is more specific.
 */
function specificity(scope) {
	const parsed = parseScope(scope)
	if (parsed === undefined) return -1
	if (parsed.kind === 'global') return 0
	if (parsed.kind === 'session') return 1_000_000
	return 1 + parsed.directory.length
}

/**
 * Derive the environment variable name for one key.
 *
 * The `ctx.shellEnv` registry accepts only `DSH_[A-Z][A-Z0-9_]*`, so the key is
 * upper-cased and every non-alphanumeric byte becomes `_`. `KEY_PATTERN`
 * already forbids `.`, which keeps this mapping injective: two distinct keys
 * cannot collide into one variable name.
 *
 * @param key - the entry key.
 * @param prefix - the configured variable prefix.
 * @returns the environment variable name.
 */
export function envNameFor(key, prefix) {
	return prefix + key.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

/**
 * The store.
 *
 * Construction is cheap and synchronous; `ready` resolves once disk has been
 * read. Everything the shell-environment contributor needs is available
 * synchronously from that point on.
 */
export class SecretStore {
	/**
	 * @param options - store options.
	 * @param options.dataDir - directory holding the store document.
	 * @param options.encryption - `dpapi` or `none`.
	 * @param options.keyPrefix - environment variable prefix.
	 * @param options.maxEntries - entry ceiling.
	 * @param options.cipher - the DPAPI cipher, or undefined when encryption is off.
	 * @param options.logger - a Cordis-style logger; `warn` and `info` are used when present.
	 */
	constructor(options) {
		this.dataDir = options.dataDir
		this.encryption = options.encryption === 'none' ? 'none' : 'dpapi'
		this.keyPrefix = options.keyPrefix
		this.maxEntries = options.maxEntries
		this.cipher = options.cipher
		this.logger = options.logger
		/** Resolves when the first load attempt has settled; never rejects. */
		this.ready = this.#load()
		/** Bumped on every committed change, for derived caches. */
		this.generation = 0
		this.listeners = new Set()
	}

	/** @type {Array<object>} */
	entries = []

	/** Whether the document exists but could not be read. */
	locked = false

	/** Why the store is locked or degraded. */
	warnings = []

	/** Whether the active document on disk is sealed. */
	sealed = false

	/** Whether writes are accepted right now. */
	writable = false

	/**
	 * Read the document from disk, sealing or opening it as configured.
	 *
	 * Never throws: a failure becomes `locked` plus a warning, because a plugin
	 * that throws during `apply` takes the whole composition down with it, and
	 * losing the settings page is a smaller failure than losing the harness.
	 *
	 * @returns a promise that settles when the attempt is over.
	 */
	async #load() {
		try {
			fs.mkdirSync(this.dataDir, { recursive: true })
		} catch (error) {
			this.#warn('dirNotWritable', `数据目录不可用：${this.dataDir}（${error?.message ?? error}）`)
			return
		}

		const sealedPath = path.join(this.dataDir, SEALED_FILE)
		const plainPath = path.join(this.dataDir, PLAIN_FILE)
		const hasSealed = fs.existsSync(sealedPath)
		const hasPlain = fs.existsSync(plainPath)

		let text
		if (hasSealed) {
			// A sealed document is authoritative: it is what the user last wrote,
			// so a config flip to `none` must not silently orphan it.
			this.sealed = true
			if (this.cipher === undefined) {
				this.#lock(`已存在的加密文件无法解密：未启用 DPAPI。请在同一 Windows 账户下运行，或先移走 ${SEALED_FILE}。`)
				return
			}
			await this.cipher.ready()
			if (!this.cipher.available) {
				this.#lock(`已存在的加密文件无法解密：${this.cipher.reason ?? '未知原因'}。请在同一 Windows 账户下运行，或先移走 ${SEALED_FILE}。`)
				return
			}
			try {
				text = await this.cipher.unprotect(fs.readFileSync(sealedPath))
			} catch (error) {
				this.#lock(`加密文件无法解密：${error?.message ?? error}`)
				return
			}
		} else if (hasPlain) {
			// An existing plaintext document keeps being plaintext. Rewriting it
			// sealed would leave the readable copy behind, and deleting the user's
			// file on a config change is not this plugin's call to make.
			this.sealed = false
			if (this.encryption === 'dpapi') {
				this.#warn('plaintextExisting', `检测到明文存储文件 ${PLAIN_FILE}，继续以明文读写；如需启用 DPAPI 加密，请先移走该文件（密钥会在下次写入时以加密形式重建）。`)
			}
			try {
				text = fs.readFileSync(plainPath, 'utf8')
			} catch (error) {
				this.#warn('unreadable', `存储文件无法读取：${error?.message ?? error}`)
				this.entries = []
				this.writable = false
				return
			}
		} else {
			// Nothing on disk yet: the only moment the encryption mode is a free
			// choice, because there is no ciphertext to orphan.
			this.sealed = this.encryption === 'dpapi'
			if (this.sealed) {
				if (this.cipher === undefined) {
					this.sealed = false
					this.#warn('encryptionUnavailable', 'DPAPI 不可用（未提供 cipher），本次以明文存储。')
				} else {
					await this.cipher.ready()
					if (!this.cipher.available) {
						this.sealed = false
						this.#warn('encryptionUnavailable', `DPAPI 不可用，本次以明文存储：${this.cipher.reason ?? '未知原因'}`)
					}
				}
			}
			this.entries = []
			this.writable = true
			this.#assertWritableDirectory()
			return
		}

		const parsed = this.#parse(text)
		this.entries = parsed.entries
		for (const warning of parsed.warnings) this.warnings.push(warning)
		this.writable = true
		this.#assertWritableDirectory()
	}

	/**
	 * Decode one document body.
	 * @param text - the plaintext document.
	 * @returns the accepted entries plus any per-entry complaints.
	 */
	#parse(text) {
		const warnings = []
		let document
		try {
			document = JSON.parse(text)
		} catch (error) {
			warnings.push({ code: 'corrupt', message: `存储文件不是合法 JSON：${error?.message ?? error}` })
			return { entries: [], warnings }
		}
		if (document === null || typeof document !== 'object' || !Array.isArray(document.entries)) {
			warnings.push({ code: 'corrupt', message: '存储文件缺少 entries 数组。' })
			return { entries: [], warnings }
		}
		const entries = []
		const seen = new Set()
		for (const raw of document.entries) {
			const entry = this.#adopt(raw)
			if (entry === undefined) {
				warnings.push({ code: 'entryDropped', message: `已丢弃一条不合法的记录：${JSON.stringify(raw)?.slice(0, 120) ?? 'null'}` })
				continue
			}
			const identity = `${entry.scope}\u0000${entry.env}`
			if (seen.has(identity)) {
				warnings.push({ code: 'entryDropped', message: `已丢弃重复的记录：${entry.scope} / ${entry.key}` })
				continue
			}
			seen.add(identity)
			entries.push(entry)
		}
		return { entries, warnings }
	}

	/**
	 * Validate one stored record.
	 * @param raw - the raw record.
	 * @returns a normalized entry, or undefined when it cannot be trusted.
	 */
	#adopt(raw) {
		if (raw === null || typeof raw !== 'object') return undefined
		if (parseScope(raw.scope) === undefined) return undefined
		if (typeof raw.key !== 'string' || !KEY_PATTERN.test(raw.key)) return undefined
		if (typeof raw.value !== 'string') return undefined
		return {
			scope: raw.scope,
			key: raw.key,
			env: envNameFor(raw.key, this.keyPrefix),
			value: raw.value,
			description: typeof raw.description === 'string' ? raw.description : '',
			createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
			updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
		}
	}

	/**
	 * Mark the store unreadable and read-only.
	 * @param message - the user-facing reason.
	 */
	#lock(message) {
		this.locked = true
		this.writable = false
		this.entries = []
		this.#warn('locked', message)
	}

	/**
	 * Record one degradation.
	 * @param code - a stable identifier the GUI keys on.
	 * @param message - the user-facing text.
	 */
	#warn(code, message) {
		if (this.warnings.some((warning) => warning.code === code)) return
		this.warnings.push({ code, message })
		this.logger?.warn?.(`secret-broker: ${message}`)
	}

	/** Probe that the data directory accepts writes, so the GUI can say so up front. */
	#assertWritableDirectory() {
		const probe = path.join(this.dataDir, '.write-probe')
		try {
			fs.writeFileSync(probe, 'ok')
			fs.unlinkSync(probe)
		} catch (error) {
			this.writable = false
			this.#warn('dirNotWritable', `数据目录不可写：${this.dataDir}（${error?.message ?? error}）`)
		}
	}

	// ------------------------------------------------------------- read side

	/**
	 * The effective entries for one execution: globals, then every project the
	 * working directory sits in (shallowest first), then that session's own
	 * entries — so the most specific scope wins a shared key.
	 *
	 * @param sessionId - the session id, when the caller has one.
	 * @param cwd - the session's working directory, when it has one.
	 * @returns the entries in effect, ordered by key.
	 */
	effective(sessionId, cwd) {
		const hasSession = typeof sessionId === 'string' && sessionId.length > 0
		const own = hasSession ? sessionScope(sessionId) : undefined
		const hasCwd = typeof cwd === 'string' && cwd.length > 0
		const applicable = []
		for (const entry of this.entries) {
			const parsed = parseScope(entry.scope)
			if (parsed === undefined) continue
			if (parsed.kind === 'global') applicable.push(entry)
			else if (parsed.kind === 'project') {
				if (hasCwd && pathContains(parsed.directory, cwd)) applicable.push(entry)
			} else if (hasSession && entry.scope === own) applicable.push(entry)
		}
		// Stable sort, so two projects of equal depth keep a deterministic order.
		applicable.sort((left, right) => specificity(left.scope) - specificity(right.scope))
		const byKey = new Map()
		for (const entry of applicable) byKey.set(entry.key, entry)
		return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key))
	}

	/**
	 * The environment variables the store can contribute, with descriptions the
	 * registry requires to be non-empty.
	 *
	 * The declaration set is the union over *all* scopes, because `ctx.shellEnv`
	 * fixes a contributor's variable names at registration time while the value
	 * set is decided per execution. Declaring a superset and resolving a subset
	 * is exactly the contract.
	 *
	 * @returns a plain object mapping variable name to `{ description }`.
	 */
	declarations() {
		const variables = {}
		for (const entry of this.entries) {
			if (Object.hasOwn(variables, entry.env)) continue
			const detail = entry.description.trim().length > 0 ? entry.description.trim() : '用户录入的敏感值'
			variables[entry.env] = { description: `${entry.key}（${scopeLabel(entry.scope)}）— ${detail}` }
		}
		return variables
	}

	/**
	 * The values worth scanning tool results for, for one execution.
	 *
	 * @param sessionId - the session id.
	 * @param cwd - the session's working directory.
	 * @returns `[value, key]` pairs, longest value first so a value containing
	 *   another value is replaced before its own substring.
	 */
	redactionPairs(sessionId, cwd) {
		return this.effective(sessionId, cwd)
			.map((entry) => [entry.value, entry.key])
			.sort((left, right) => right[0].length - left[0].length)
	}

	/**
	 * Every entry, for the settings page.
	 * @returns a defensive copy.
	 */
	all() {
		return this.entries.map((entry) => ({ ...entry }))
	}

	/**
	 * A wire-safe projection: metadata only, never a value.
	 * @param entry - one entry.
	 * @returns the public shape.
	 */
	static metadata(entry) {
		return {
			key: entry.key,
			scope: entry.scope,
			env: entry.env,
			description: entry.description,
			createdAt: entry.createdAt,
			updatedAt: entry.updatedAt,
		}
	}

	// ------------------------------------------------------------ write side

	/**
	 * Create or replace one entry.
	 *
	 * @param request - the write request.
	 * @param request.key - the key.
	 * @param request.value - the secret value; an empty string is refused, because
	 *   a blank that looks configured is worse than an absent key.
	 * @param request.scope - `global` or `session:<id>`.
	 * @param request.description - optional free text.
	 * @returns the stored entry's metadata.
	 */
	async set(request) {
		const key = String(request.key ?? '').trim()
		if (!KEY_PATTERN.test(key)) {
			throw new Error('密钥名必须是字母开头、仅含字母数字下划线与连字符的 1–64 字符标识符')
		}
		const scope = canonicalScope(request.scope)
		if (scope === undefined) {
			throw new Error('作用域必须是 global 或 session:<会话 id>')
		}
		const value = String(request.value ?? '')
		if (value.length === 0) throw new Error('值不能为空；如需移除请使用删除')
		if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
			throw new Error(`值过长（超过 ${String(MAX_SECRET_BYTES)} 字节）`)
		}
		const description = String(request.description ?? '')
		const env = envNameFor(key, this.keyPrefix)

		return await this.#mutate((entries) => {
			// The variable namespace is flat, so two *different* keys may not fold
			// onto one name whenever a single execution could see both. The same key
			// in overlapping scopes is the intended shadowing case.
			const clash = entries.find((entry) => entry.env === env
				&& entry.key !== key
				&& scopesOverlap(entry.scope, scope))
			if (clash !== undefined) throw new Error(`环境变量名 ${env} 已被 ${clash.key}（${scopeLabel(clash.scope)}）占用；换一个键名或换一个作用域`)
			const now = new Date().toISOString()
			const existing = entries.find((entry) => entry.scope === scope && entry.key === key)
			if (existing === undefined) {
				if (entries.length >= this.maxEntries) throw new Error(`条目数已达上限 ${String(this.maxEntries)}`)
				entries.push({ scope, key, env, value, description, createdAt: now, updatedAt: now })
				return entries
			}
			existing.value = value
			existing.env = env
			existing.description = description
			existing.updatedAt = now
			return entries
		}, (entries) => SecretStore.metadata(entries.find((entry) => entry.scope === scope && entry.key === key)))
	}

	/**
	 * Remove one entry.
	 *
	 * @param request - the delete request.
	 * @param request.key - the key.
	 * @param request.scope - the scope it lives in.
	 * @returns whether an entry was removed.
	 */
	async remove(request) {
		const key = String(request.key ?? '').trim()
		const scope = canonicalScope(request.scope)
		if (scope === undefined) throw new Error('作用域必须是 global 或 session:<会话 id>')
		let removed = false
		await this.#mutate((entries) => {
			const index = entries.findIndex((entry) => entry.scope === scope && entry.key === key)
			if (index === -1) return entries
			entries.splice(index, 1)
			removed = true
			return entries
		})
		return removed
	}

	/**
	 * Move one entry to another scope.
	 *
	 * @param request - the move request.
	 * @param request.key - the key.
	 * @param request.from - the current scope.
	 * @param request.to - the destination scope.
	 * @returns the moved entry's metadata.
	 */
	async promote(request) {
		const key = String(request.key ?? '').trim()
		const from = canonicalScope(request.from)
		const to = canonicalScope(request.to)
		if (from === undefined || to === undefined) {
			throw new Error('作用域必须是 global 或 session:<会话 id>')
		}
		if (from === to) throw new Error('源作用域与目标作用域相同')
		return await this.#mutate((entries) => {
			const index = entries.findIndex((entry) => entry.scope === from && entry.key === key)
			if (index === -1) throw new Error(`没有找到 ${from} 下的 ${key}`)
			const target = entries.find((entry) => entry.scope === to && entry.key === key)
			if (target !== undefined) {
				target.value = entries[index].value
				target.description = entries[index].description
				target.updatedAt = new Date().toISOString()
				entries.splice(index, 1)
				return entries
			}
			const moved = entries[index]
			moved.scope = to
			moved.updatedAt = new Date().toISOString()
			return entries
		}, (entries) => {
			const moved = entries.find((entry) => entry.scope === to && entry.key === key)
			return moved === undefined ? undefined : SecretStore.metadata(moved)
		})
	}

	/**
	 * Read the document, apply one mutation under the lock, and commit it.
	 *
	 * The mutation works on a *fresh* copy read inside the lock: another process
	 * may have written between this store's last load and now, and losing that
	 * change is exactly the bug the lock exists to prevent.
	 *
	 * @param mutate - receives the current entries, returns them mutated.
	 * @param project - builds the return value from the committed entries.
	 * @returns the projected value.
	 */
	async #mutate(mutate, project) {
		await this.ready
		if (this.locked) throw new Error('密钥存储当前为只读：加密文件无法解密，已拒绝写入以避免覆盖')
		if (!this.writable) throw new Error('密钥存储当前不可写，请检查数据目录权限')

		const release = await this.#acquireLock()
		try {
			const onDisk = await this.#readForWrite()
			const draft = onDisk.map((entry) => ({ ...entry }))
			const mutated = mutate(draft)
			const committed = Array.isArray(mutated) ? mutated : draft
			await this.#write(committed)
			this.entries = committed
			this.generation += 1
			this.#notify()
			return project === undefined ? undefined : project(committed)
		} finally {
			release()
		}
	}

	/**
	 * Re-read the document for a write, tolerating a missing file.
	 * @returns the entries currently on disk.
	 */
	async #readForWrite() {
		const sealedPath = path.join(this.dataDir, SEALED_FILE)
		const plainPath = path.join(this.dataDir, PLAIN_FILE)
		try {
			if (this.sealed) {
				if (this.cipher === undefined || !this.cipher.available) throw new Error('DPAPI 不可用')
				return this.#parse(await this.cipher.unprotect(fs.readFileSync(sealedPath))).entries
			}
			if (fs.existsSync(plainPath)) return this.#parse(fs.readFileSync(plainPath, 'utf8')).entries
		} catch (error) {
			this.logger?.warn?.(`secret-broker: 写入前重读失败，改用内存快照：${error?.message ?? error}`)
			return this.entries.map((entry) => ({ ...entry }))
		}
		return []
	}

	/**
	 * Commit the document: back up, then replace atomically.
	 * @param entries - the entries to persist.
	 */
	async #write(entries) {
		const document = JSON.stringify({ version: DOCUMENT_VERSION, entries }, null, 2)
		const target = path.join(this.dataDir, this.sealed ? SEALED_FILE : PLAIN_FILE)
		const body = this.sealed ? await this.#seal(document) : Buffer.from(document, 'utf8')
		if (fs.existsSync(target)) {
			try {
				fs.copyFileSync(target, target + BACKUP_SUFFIX)
			} catch (error) {
				this.logger?.warn?.(`secret-broker: 备份失败：${error?.message ?? error}`)
			}
		}
		const temporary = target + '.tmp'
		fs.writeFileSync(temporary, body)
		fs.renameSync(temporary, target)
	}

	/**
	 * Seal a document, converting an unavailable cipher into a readable error.
	 * @param document - the plaintext document.
	 * @returns the sealed bytes.
	 */
	async #seal(document) {
		if (this.cipher === undefined || !this.cipher.available) throw new Error('DPAPI 不可用，无法加密写入')
		return await this.cipher.protect(document)
	}

	/**
	 * Take the store lock, waiting briefly for a concurrent writer.
	 * @returns the release function.
	 */
	async #acquireLock() {
		const lockPath = path.join(this.dataDir, LOCK_FILE)
		for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
			try {
				const handle = fs.openSync(lockPath, 'wx')
				fs.writeSync(handle, `${String(process.pid)} ${new Date().toISOString()}`)
				fs.closeSync(handle)
				return () => {
					try {
						fs.unlinkSync(lockPath)
					} catch {
						/* another writer already cleared it */
					}
				}
			} catch (error) {
				if (error?.code !== 'EEXIST') throw error
				try {
					const age = Date.now() - fs.statSync(lockPath).mtimeMs
					if (age > LOCK_STALE_MS) {
						fs.unlinkSync(lockPath)
						continue
					}
				} catch {
					continue
				}
				await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
			}
		}
		throw new Error('密钥存储正被另一个进程写入，请稍后重试')
	}

	/**
	 * Subscribe to committed changes.
	 * @param listener - called after every successful write.
	 * @returns the unsubscribe function.
	 */
	onChange(listener) {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	/** Fan one committed change out, containing listener failures. */
	#notify() {
		for (const listener of this.listeners) {
			try {
				listener()
			} catch (error) {
				this.logger?.warn?.(`secret-broker: 变更监听器抛错：${error?.message ?? error}`)
			}
		}
	}
}
