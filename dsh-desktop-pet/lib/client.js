// dsh-desktop-pet — browser half.
//
// A self-contained Live2D desk pet for the DSH Web GUI. This file is a
// hand-written `__ModuleLoader__` factory with no build step: it requires
// nothing at all, because the module table seeds only React and a few DSH
// packages, and a pet needs neither.
//
// What it does:
//
//   * loads the MIT vendor bundle (pixi.js + the Live2D engine) and Live2D's
//     proprietary Cubism Core runtime from the host's runtime routes, lazily,
//     only once the pet is actually mounted;
//   * renders the model on a floating, draggable, resizable surface pinned to
//     the page;
//   * makes the surface transparent to pointer events everywhere the model is
//     not drawn, so the pet never blocks the DSH UI underneath it;
//   * follows the pointer with the model's eyes and head;
//   * turns 44 expressions into 20 mutually-exclusive "look" slots by writing
//     their (all-additive) parameters into the core model each frame — the
//     engine can only hold one expression at a time, so the slot model has to
//     be driven directly;
//   * reacts to clicks, to a double click, and to the DSH session's activity,
//     which the host half folds into one coarse phase and streams over SSE.
//
// The proprietary Cubism Core runtime is never bundled here either: the page
// asks the host for it, and the host fetches it from Live2D's official CDN once
// and caches it locally.

window.__ModuleLoader__.load({
	id: 'dsh-desktop-pet',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		// The one external this bundle needs. React is in the shell's frozen
		// platform module table, so it resolves without a `dsh.client.external`
		// declaration; it is here for the sidebar toggle, the pet's way back once
		// it has been hidden. Resolved defensively: a shell that did not seed it
		// should cost the toggle, not the pet.
		let react
		try {
			react = require('react')
		} catch {
			react = undefined
		}

		// ------------------------------------------------------------ constants

		const API = '/api/dsh-pet'
		const ROOT_ATTR = 'data-dsh-desktop-pet'
		const STORAGE_KEY = 'dsh-desktop-pet.state.v1'
		/**
		 * Where the last boot failure is kept. A pet that fails to mount leaves
		 * nothing on screen to inspect — the notice is transient and the console is
		 * not always reachable — so the reason is written down where it survives a
		 * reload and can be read back later.
		 */
		const ERROR_KEY = 'dsh-desktop-pet.last-error'
		/**
		 * Where a successful mount records the URLs it used.
		 *
		 * The one class of bug that only appears on the desktop app is a URL that
		 * resolves differently under its non-`http` origin, and the URLs the engine
		 * hands to its image worker are the only place that is visible. Recording
		 * them makes "works in the browser, 404s in the app" a readable fact
		 * instead of a guess.
		 */
		const URLS_KEY = 'dsh-desktop-pet.last-urls'

		/**
		 * The box the model's frame is fitted into at scale 1, in CSS pixels. The
		 * real surface is then sized to that frame at the current scale, so the pet
		 * can be resized without ever being clipped by its own canvas.
		 */
		const BASE_WIDTH = 520
		const BASE_HEIGHT = 580

		/** User scale bounds. */
		const SCALE_MIN = 0.4
		const SCALE_MAX = 2.5

		/**
		 * Padding around the model's content box, as a multiplier.
		 *
		 * The box is measured once, in the pose the model happens to load in, but
		 * the idle animation and the props (the whale, the desk, a raised hammer)
		 * move the silhouette: measured on this model, the union across a few
		 * seconds of idle is about 8% wider than that single frame. A quarter again
		 * is enough headroom that nothing is ever cut off by the canvas edge, and
		 * the extra transparent margin costs nothing because the surface stays
		 * pointer-transparent wherever the model is not actually drawn.
		 */
		const FRAME_PADDING = 1.25

		/** How long a speech bubble stays up, and the double-click window. */
		const BUBBLE_MS = 3_200
		const DOUBLE_CLICK_MS = 320

		/** Where the pet lands the first time it is shown. */
		const DEFAULT_MARGIN = 24

		/**
		 * The first-run scale. Deliberately small: the pet shares the window with
		 * the composer, and a character that sits clear of it reads as a desk pet
		 * rather than an obstruction. The user can scale it from the panel or the
		 * wheel, and 复位 comes back here.
		 */
		const DEFAULT_SCALE = 0.7

		/**
		 * The scale this plugin used to ship as its default. A saved state still on
		 * exactly this value has never been deliberately chosen, so it follows the
		 * new default once.
		 */
		const LEGACY_DEFAULT_SCALE = 0.8

		/** Bumped whenever `LEGACY_DEFAULT_SCALE` moves to a new value. */
		const SCALE_VERSION = 1

		// -------------------------------------------------------------- storage

		/**
		 * `localStorage` has to be wrapped: some desktop shells throw a
		 * SecurityError on the very first property access (opaque origin,
		 * hardened privacy settings), and a throw inside the first render would
		 * take the whole pet down. An in-memory stand-in keeps the session
		 * usable; only persistence across reloads is lost.
		 */
		function createStorage() {
			try {
				const probe = '__dsh_desktop_pet_probe__'
				window.localStorage.setItem(probe, '1')
				window.localStorage.removeItem(probe)
				return window.localStorage
			} catch {
				const memory = new Map()
				return {
					getItem: (key) => (memory.has(key) ? memory.get(key) : null),
					setItem: (key, value) => memory.set(key, String(value)),
					removeItem: (key) => memory.delete(key),
				}
			}
		}

		// ----------------------------------------------------------- runtime load

		/**
		 * Absolute URL for one of the host's routes.
		 *
		 * Every URL handed to the Live2D engine has to be absolute, and that is not
		 * cosmetic. The engine resolves a model's files with a helper that, given a
		 * *root-relative* model URL, hands back root-relative texture URLs; pixi
		 * then fetches those from a **blob worker**, whose base URL is
		 * `blob:<origin>/<uuid>`. Against `http://` that still resolves correctly,
		 * but the desktop app's origin is the non-special scheme `dsh-app://app`,
		 * where `/api/...` resolved against the blob base comes out as
		 * `dsh-app://api/...` — the host is eaten, the protocol handler answers 404,
		 * and the pet dies on a texture that is sitting right there on disk.
		 *
		 * An absolute URL makes the engine produce absolute texture URLs, which the
		 * worker then fetches verbatim, whatever the scheme.
		 *
		 * @param path - a root-relative route on this origin.
		 * @returns the same route as an absolute URL.
		 */
		function absoluteUrl(path) {
			return new URL(path, window.location.href).href
		}

		/**
		 * Inject one classic script and resolve when it has executed.
		 *
		 * A classic script that throws while running still fires `load`, not
		 * `error` — so "it loaded" is not the same as "it worked". Any uncaught
		 * error raised while the script runs is collected here and handed back, so
		 * a bundle that loaded but died says why instead of just publishing
		 * nothing.
		 *
		 * @param source - the script URL.
		 * @returns the messages of any uncaught errors the script raised.
		 */
		function loadScript(source) {
			return new Promise((resolve, reject) => {
				const element = document.createElement('script')
				const failures = []
				const capture = (event) => {
					failures.push(String(event?.message ?? event?.error ?? 'unknown script error'))
				}
				window.addEventListener('error', capture)
				const settle = () => window.removeEventListener('error', capture)
				element.src = source
				element.async = true
				element.onload = () => {
					settle()
					resolve(failures)
				}
				element.onerror = () => {
					settle()
					reject(new Error(`failed to load ${source}`))
				}
				document.head.appendChild(element)
			})
		}

		/**
		 * The vendor bundle and the Cubism Core runtime, loaded once per page.
		 *
		 * Order matters: the engine reads `window.Live2DCubismCore` when a model
		 * is created, so the proprietary runtime has to be on the page before
		 * the vendor bundle is asked to do anything.
		 */
		class RuntimeLoader {
			constructor() {
				this.vendor = undefined
				this.coreStatus = 'unknown'
				this.inflight = undefined
				this.failure = undefined
			}

			/** Whether the vendor bundle is already on the page. */
			get ready() {
				return this.vendor !== undefined
			}

			/**
			 * Load whatever is still missing.
			 * @param catalog - the host's catalog response.
			 * @returns the vendor namespace, or throws with a readable reason.
			 */
			async ensure(catalog) {
				if (this.vendor !== undefined) return this.vendor
				if (this.inflight !== undefined) return this.inflight
				this.inflight = this.#load(catalog).finally(() => {
					this.inflight = undefined
				})
				return this.inflight
			}

			async #load(catalog) {
				if (globalThis.Live2DCubismCore === undefined) {
					let coreErrors = []
					try {
						coreErrors = await loadScript(absoluteUrl(catalog.runtime.core))
						this.coreStatus = 'loaded'
					} catch (error) {
						this.coreStatus = 'unavailable'
						this.failure = error
						throw new Error(
							'the Live2D Cubism Core runtime could not be loaded. '
							+ 'The host fetches it from Live2D\'s official CDN on first use; '
							+ 'place live2dcubismcore.min.js in $DSH_HOME/desktop-pet/.runtime/ '
							+ 'to work offline.',
						)
					}
					if (globalThis.Live2DCubismCore === undefined) {
						this.coreStatus = 'unavailable'
						throw new Error(
							'the Cubism Core runtime loaded but did not publish window.Live2DCubismCore'
							+ (coreErrors.length > 0 ? `: ${coreErrors[0]}` : ''),
						)
					}
				} else {
					this.coreStatus = 'present'
				}
				// The vendor bundle is a separate artifact from this file, so a client
				// reload — HMR, or a second mount — must not re-execute it. Every
				// execution builds a fresh Cubism framework over the *one* shared
				// Cubism Core, and re-initialising that core over and over exhausts
				// its WebAssembly table ("Unable to grow wasm table"), which is a
				// failure the user sees as the pet dying after an edit.
				if (globalThis.__dshPetVendor !== undefined) {
					this.vendor = globalThis.__dshPetVendor
					return this.vendor
				}
				const vendorErrors = await loadScript(absoluteUrl(catalog.runtime.vendor))
				const vendor = globalThis.__dshPetVendor
				if (vendor === undefined) {
					throw new Error(
						'the vendor bundle loaded but published nothing'
						+ (vendorErrors.length > 0 ? `: ${vendorErrors[0]}` : ' (and raised no error)'),
					)
				}
				this.vendor = vendor
				return vendor
			}
		}

		// ------------------------------------------------------------------ pet

		/**
		 * The floating pet: a Pixi application, the loaded model, the look
		 * state, and every interaction handler.
		 */
		class DesktopPet {
			constructor(host, catalog, options) {
				this.host = host
				this.catalog = catalog
				this.manifest = catalog.manifest ?? {}
				this.options = options
				this.vendor = undefined
				this.app = undefined
				this.model = undefined
				this.stage = undefined
				this.canvas = undefined
				this.bubble = undefined
				this.panel = undefined
				this.destroyed = false

				/** Per-expression additive parameter lists, keyed by expression name. */
				this.expressionParameters = new Map()
				/**
				 * `userLook` and `phaseLook` are slot id -> option label. `userLook`
				 * aliases the persisted state object rather than copying it, so a
				 * slot change is saved without any extra bookkeeping.
				 */
				if (options.state.look === null || typeof options.state.look !== 'object') options.state.look = {}
				this.userLook = options.state.look
				this.phaseLook = {}
				/** Hand-made choices that beat the phase for one slot, until it changes. */
				this.phaseOverrides = {}
				this.preset = new Map()
				this.heldMotion = undefined
				this.mask = undefined
				this.maskDirty = true
				this.pointer = { x: 0, y: 0, inside: false }
				this.bubbleTimer = undefined
				this.clickTimer = undefined
				this.lastClickAt = 0
				this.eventSource = undefined
				this.fitScale = 1
				this.centre = { x: 0, y: 0 }
				this.contentSize = { width: BASE_WIDTH, height: BASE_HEIGHT }
				this.stageSize = { width: BASE_WIDTH, height: BASE_HEIGHT }
				this.disposers = []
			}

			// --------------------------------------------------------------- setup

			/** Build the DOM, load the runtime, load the model. */
			async mount() {
				const vendor = await this.#loadRuntime()
				if (this.destroyed) return
				await this.#loadExpressions()
				await this.#loadModel(vendor)
				if (this.destroyed) return
				this.#bindInteractions()
				this.#subscribePhase()
				this.#applyLook()
				this.#announce()
			}

			async #loadRuntime() {
				const loader = new RuntimeLoader()
				const vendor = await loader.ensure(this.catalog)
				this.vendor = vendor
				return vendor
			}

			#buildDom() {
				this.stage = document.createElement('div')
				this.stage.className = 'dsh-pet-stage'
				this.stage.style.cssText = [
					'position:absolute',
					'left:0',
					'top:0',
					`width:${BASE_WIDTH}px`,
					`height:${BASE_HEIGHT}px`,
					'pointer-events:none',
					'will-change:transform',
					'transform:translate3d(0,0,0)',
				].join(';')

				this.bubble = document.createElement('div')
				this.bubble.className = 'dsh-pet-bubble'
				this.bubble.setAttribute('aria-hidden', 'true')
				this.bubble.style.cssText = [
					'position:absolute',
					'left:50%',
					'top:6px',
					'transform:translate(-50%,0) scale(0.9)',
					'max-width:240px',
					'padding:7px 12px',
					'border-radius:12px',
					// DSH theme tokens, so the bubble follows the app's light/dark mode.
					'background:var(--dsw-alias-bg-layer-1,rgba(28,28,32,0.94))',
					'color:var(--dsw-alias-label-primary,#f5f5f7)',
					'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.12))',
					'font:500 13px/1.45 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
					'text-align:center',
					'white-space:pre-wrap',
					'box-shadow:0 6px 20px rgba(0,0,0,0.18)',
					'opacity:0',
					'pointer-events:none',
					'transition:opacity 160ms ease,transform 160ms ease',
					'z-index:2',
				].join(';')

				this.stage.appendChild(this.bubble)
				this.host.appendChild(this.stage)
			}

			/**
			 * Fetch every expression file once and index its parameters. The
			 * model's expressions are all `Blend: "Add"`, which is what makes the
			 * slot model work: a look is the sum of the selected options'
			 * parameters, written on top of the motion base every frame.
			 */
			async #loadExpressions() {
				const definitions = this.catalog.expressions ?? this.manifest.expressions ?? {}
				const names = Object.keys(definitions)
				await Promise.all(names.map(async (name) => {
					const relative = definitions[name]
					if (typeof relative !== 'string') return
					try {
						const response = await fetch(absoluteUrl(`${API}/asset/${relative}`))
						if (!response.ok) return
						const json = await response.json()
						const parameters = []
						for (const parameter of json.Parameters ?? []) {
							if (typeof parameter?.Id !== 'string') continue
							parameters.push({
								id: parameter.Id,
								value: Number(parameter.Value) || 0,
								blend: parameter.Blend ?? 'Add',
							})
						}
						this.expressionParameters.set(name, parameters)
					} catch {
						/* one unreadable expression must not stop the pet */
					}
				}))
			}

			async #loadModel(vendor) {
				const { Application, MotionPriority, Live2DPlugin, Live2DModel, extensions, configureCubismSDK } = vendor
				this.MotionPriority = MotionPriority
				// Registering the render pipe twice (an HMR reload, a second pet)
				// is harmless but noisy, so it happens once per page.
				if (globalThis.__dshPetPluginRegistered !== true) {
					extensions.add(Live2DPlugin)
					// Starting the Cubism framework here only pre-sizes its work
					// memory; the engine starts it lazily, with its own retries, when
					// the first model is created. So a failure here is not fatal and
					// must not take the pet down with it.
					try {
						configureCubismSDK({ memorySizeMB: 32 })
					} catch (error) {
						this.options.ctx?.logger?.warn?.(`desktop-pet: Cubism pre-configuration skipped: ${error?.message ?? error}`)
					}
					globalThis.__dshPetPluginRegistered = true
				}

				const app = new Application()
				await app.init({
					width: BASE_WIDTH,
					height: BASE_HEIGHT,
					backgroundAlpha: 0,
					antialias: true,
					autoDensity: true,
					resolution: Math.min(window.devicePixelRatio || 1, 2),
					preference: 'webgl',
					hello: false,
				})
				if (this.destroyed) {
					app.destroy(true)
					return
				}
				this.app = app
				this.canvas = app.canvas
				this.canvas.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none'
				this.stage.insertBefore(this.canvas, this.bubble)

				const model = await this.#loadModelWithRetry(Live2DModel)
				if (this.destroyed) {
					model?.destroy()
					return
				}
				if (model === undefined) return
				this.model = model
				app.stage.addChild(model)
				this.#fitModel()

				// Every frame starts from the motion base; expressions are applied
				// on top and are not saved into it. Writing the look here is
				// therefore the exact analogue of the engine's own expression pass,
				// except that it can carry as many expressions as the look needs.
				this.model.internalModel.on('beforeModelUpdate', () => this.#applyLookParameters())
				// A one-shot motion's props have to be cleared off the model when it
				// ends, and this event is the only completion signal the engine
				// actually delivers (its `onFinish` option is dropped). The idle
				// motion never fires it, because idle loops.
				this.model.internalModel.motionManager.on('motionFinish', () => {
					if (this.heldMotion !== undefined) return
					this.#resetPose()
				})
				app.ticker.add(() => {
					this.maskDirty = true
				})
			}

			/**
			 * Load the model, retrying once.
			 *
			 * The model arrives as half a dozen separate requests (the definition,
			 * the moc, the physics, two textures, the motions). One of them losing a
			 * race — or a host that is still warming up right after a restart — used
			 * to leave the pet permanently broken until the page was reloaded. One
			 * retry after a short pause turns that into a slightly slower start.
			 *
			 * @param Live2DModel - the engine's model class from the vendor bundle.
			 * @returns the loaded model, or `undefined` when both attempts failed.
			 */
			async #loadModelWithRetry(Live2DModel) {
				const options = {
					// The pet does its own focus and hit testing: the engine's
					// automator would hit-test against `HitAreas`, which this model
					// does not declare.
					autoInteract: false,
					idleMotionGroup: this.manifest.idleMotion ?? 'Idle',
				}
				// Absolute, so every file the engine derives from it is absolute too.
				const source = absoluteUrl(this.catalog.model)
				this.modelSource = source
				try {
					return await Live2DModel.from(source, options)
				} catch (first) {
					if (this.destroyed) return undefined
					await new Promise((resolve) => setTimeout(resolve, 900))
					if (this.destroyed) return undefined
					try {
						return await Live2DModel.from(source, options)
					} catch {
						// Report the first failure: it names the file that went missing,
						// which is more useful than the retry's.
						throw first
					}
				}
			}

			/**
			 * Fit the model's visible content box into the stage, so the pet is
			 * framed the same whatever the model's canvas size happens to be.
			 */
			#fitModel() {
				const internal = this.model.internalModel
				const core = internal.coreModel
				const count = core.getDrawableCount()
				const tmp = {}
				let minX = Infinity
				let minY = Infinity
				let maxX = -Infinity
				let maxY = -Infinity
				for (let index = 0; index < count; index += 1) {
					if (!core.getDrawableDynamicFlagIsVisible(index)) continue
					const bounds = internal.getDrawableBounds(index, tmp)
					if (!(bounds.width > 0.5 && bounds.height > 0.5)) continue
					// A drawable covering the whole canvas is backdrop, not content.
					if (bounds.width > internal.originalWidth * 0.95 && bounds.height > internal.originalHeight * 0.95) continue
					minX = Math.min(minX, bounds.x)
					minY = Math.min(minY, bounds.y)
					maxX = Math.max(maxX, bounds.x + bounds.width)
					maxY = Math.max(maxY, bounds.y + bounds.height)
				}
				if (!Number.isFinite(minX) || maxX - minX < 1 || maxY - minY < 1) {
					minX = 0
					minY = 0
					maxX = internal.originalWidth
					maxY = internal.originalHeight
				}
				const localTopLeft = internal.localTransform.apply({ x: minX, y: minY }, { x: 0, y: 0 })
				const localBottomRight = internal.localTransform.apply({ x: maxX, y: maxY }, { x: 0, y: 0 })
				const localMinX = Math.min(localTopLeft.x, localBottomRight.x)
				const localMaxX = Math.max(localTopLeft.x, localBottomRight.x)
				const localMinY = Math.min(localTopLeft.y, localBottomRight.y)
				const localMaxY = Math.max(localTopLeft.y, localBottomRight.y)
				const frameWidth = (localMaxX - localMinX) * FRAME_PADDING
				const frameHeight = (localMaxY - localMinY) * FRAME_PADDING
				this.centre = { x: (localMinX + localMaxX) / 2, y: (localMinY + localMaxY) / 2 }
				this.fitScale = Math.min(BASE_WIDTH / frameWidth, BASE_HEIGHT / frameHeight)
				this.contentSize = { width: frameWidth * this.fitScale, height: frameHeight * this.fitScale }
				this.model.anchor.set(0, 0)
				this.#applyTransform()
			}

			/**
			 * Resize the surface to the model's content box at the current scale and
			 * place the model inside it.
			 *
			 * The surface tracks the scale rather than staying a fixed box: a WebGL
			 * canvas clips whatever is drawn outside it, so a fixed box would cut the
			 * pet off the moment the user enlarged it. The bottom edge is what stays
			 * put, so scaling up grows the pet upward from where it is standing
			 * instead of drifting off the bottom of the window.
			 */
			#applyTransform() {
				const scale = this.fitScale * this.options.state.scale
				const width = Math.max(80, Math.round(this.contentSize.width * this.options.state.scale))
				const height = Math.max(80, Math.round(this.contentSize.height * this.options.state.scale))
				const previous = this.stageSize
				this.stageSize = { width, height }
				// Keep the pet's feet where they were across a resize — but only once
				// it has actually been placed: a `null` position means "not yet", and
				// adding a delta to it would silently turn it into 0.
				if (typeof this.options.state.x === 'number' && typeof this.options.state.y === 'number') {
					this.options.state.x += Math.round((previous.width - width) / 2)
					this.options.state.y += previous.height - height
				}
				this.stage.style.width = `${width}px`
				this.stage.style.height = `${height}px`
				this.app?.renderer.resize(width, height)
				if (this.model === undefined) return
				this.model.scale.set(scale)
				this.model.position.set(width / 2 - this.centre.x * scale, height / 2 - this.centre.y * scale)
				this.#clampPosition()
				this.#placeStage()
			}

			// ----------------------------------------------------------- interactions

			#bindInteractions() {
				const on = (target, event, handler, options) => {
					target.addEventListener(event, handler, options)
					this.disposers.push(() => target.removeEventListener(event, handler, options))
				}
				on(window, 'pointermove', (event) => this.#onPointerMove(event), { passive: true })
				on(window, 'blur', () => this.#restFocus())
				on(document, 'visibilitychange', () => {
					if (document.hidden) this.#restFocus()
				})
				on(this.stage, 'pointerdown', (event) => this.#onPointerDown(event))
				on(this.stage, 'wheel', (event) => this.#onWheel(event), { passive: false })
				on(this.stage, 'contextmenu', (event) => {
					event.preventDefault()
					this.togglePanel()
				})
				on(window, 'keydown', (event) => {
					if (event.key === 'Escape' && this.panel?.style.display === 'block') this.togglePanel(false)
				})
				on(window, 'resize', () => this.#clampPosition())
			}

			/**
			 * Pointer tracking. Two jobs: aim the model's eyes and head at the
			 * pointer, and decide whether the pet should catch pointer events at
			 * all — the surface is `pointer-events: none` unless the pointer is
			 * actually over the drawn model, so the transparent parts of the
			 * canvas stay click-through.
			 */
			#onPointerMove(event) {
				if (this.model === undefined) return
				const rect = this.canvas.getBoundingClientRect()
				const x = event.clientX - rect.left
				const y = event.clientY - rect.top
				this.pointer = { x: event.clientX, y: event.clientY, inside: true }
				this.#aim(x, y)
				const hit = this.#hitTest(x, y)
				this.stage.style.pointerEvents = hit || this.dragging ? 'auto' : 'none'
				if (!this.dragging) this.stage.style.cursor = hit ? 'grab' : ''
			}

			/** Point the eyes and head at a point in stage coordinates. */
			#aim(x, y) {
				const internal = this.model.internalModel
				const focus = internal.focusController
				if (focus !== undefined && typeof focus.focus === 'function') {
					// Proportional rather than the engine's unit-vector `focus()`:
					// the gaze drifts with the distance instead of snapping to full
					// deflection the moment the pointer leaves the centre.
					const nx = clamp((x - this.stageSize.width / 2) / (this.stageSize.width * 0.55), -1, 1)
					const ny = clamp((y - this.stageSize.height / 2) / (this.stageSize.height * 0.55), -1, 1)
					focus.focus(nx, -ny)
					return
				}
				this.model.focus(x, y)
			}

			#restFocus() {
				this.pointer.inside = false
				if (this.model === undefined) return
				const focus = this.model.internalModel.focusController
				if (focus !== undefined && typeof focus.focus === 'function') focus.focus(0, 0)
			}

			/**
			 * Whether the model is actually drawn at a stage-space point.
			 *
			 * The model declares no `HitAreas`, and `containsPoint` only tests the
			 * bounding rectangle, so the silhouette is approximated by the union of
			 * each visible drawable's own bounds — tight enough that the transparent
			 * margin around the character stays click-through, and free of the
			 * per-pixel readback a GPU-accurate test would need.
			 */
			#hitTest(x, y) {
				if (this.model === undefined) return false
				// Canvas space is exactly the space `getDrawableBounds` reports in, so
				// the engine's own world-to-canvas conversion is the whole transform.
				const point = this.model.toModelPosition({ x, y }, { x: 0, y: 0 })
				const mask = this.#mask()
				for (const box of mask) {
					if (point.x < box.minX || point.x > box.maxX) continue
					if (point.y < box.minY || point.y > box.maxY) continue
					return true
				}
				return false
			}

			/** The per-frame cache of visible drawable bounds, in canvas space. */
			#mask() {
				if (this.mask !== undefined && !this.maskDirty) return this.mask
				const internal = this.model.internalModel
				const core = internal.coreModel
				const count = core.getDrawableCount()
				const tmp = {}
				const boxes = []
				for (let index = 0; index < count; index += 1) {
					if (!core.getDrawableDynamicFlagIsVisible(index)) continue
					const bounds = internal.getDrawableBounds(index, tmp)
					if (!(bounds.width > 0.5 && bounds.height > 0.5)) continue
					boxes.push({
						minX: bounds.x,
						minY: bounds.y,
						maxX: bounds.x + bounds.width,
						maxY: bounds.y + bounds.height,
					})
				}
				this.mask = boxes
				this.maskDirty = false
				return boxes
			}

			#onPointerDown(event) {
				if (event.button === 2) return
				const rect = this.canvas.getBoundingClientRect()
				if (!this.#hitTest(event.clientX - rect.left, event.clientY - rect.top)) {
					// `pointer-events` is only refreshed on pointermove, so a stale
					// "auto" must not be allowed to swallow a click meant for the app
					// underneath the transparent part of the canvas.
					this.stage.style.pointerEvents = 'none'
					return
				}
				event.preventDefault()
				const startX = event.clientX
				const startY = event.clientY
				const originX = this.options.state.x
				const originY = this.options.state.y
				let moved = false
				this.dragging = true
				this.stage.style.cursor = 'grabbing'
				const target = event.currentTarget
				// Pointer capture is an optimisation, not a requirement: it throws
				// for a pointer id the browser is not tracking, and losing it must
				// not cost the user the drag.
				try {
					target.setPointerCapture?.(event.pointerId)
				} catch {
					/* not capturable; the window listeners below still work */
				}

				const move = (moveEvent) => {
					const dx = moveEvent.clientX - startX
					const dy = moveEvent.clientY - startY
					if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return
					moved = true
					this.options.state.x = originX + dx
					this.options.state.y = originY + dy
					this.#clampPosition()
					this.#placeStage()
				}
				const up = () => {
					try {
						target.releasePointerCapture?.(event.pointerId)
					} catch {
						/* never captured */
					}
					window.removeEventListener('pointermove', move)
					window.removeEventListener('pointerup', up)
					window.removeEventListener('pointercancel', up)
					this.dragging = false
					this.stage.style.cursor = 'grab'
					if (moved) this.save()
					else this.#onClick()
				}
				window.addEventListener('pointermove', move)
				window.addEventListener('pointerup', up)
				window.addEventListener('pointercancel', up)
			}

			#onClick() {
				const now = Date.now()
				if (now - this.lastClickAt <= DOUBLE_CLICK_MS) {
					// Second click inside the window: the pending single click is
					// cancelled so the pet does not react twice.
					this.lastClickAt = 0
					clearTimeout(this.clickTimer)
					this.clickTimer = undefined
					this.#react('doubleClick')
					return
				}
				this.lastClickAt = now
				clearTimeout(this.clickTimer)
				this.clickTimer = setTimeout(() => {
					this.clickTimer = undefined
					this.#react('click')
				}, DOUBLE_CLICK_MS)
			}

			#onWheel(event) {
				// The panel is a child of the stage and has its own scrollbar, so a
				// wheel over it is a scroll, not a zoom gesture. Without this, reading
				// the look list resized the pet.
				if (event.target instanceof Element && event.target.closest('.dsh-pet-panel') !== null) return
				event.preventDefault()
				this.setScale(this.options.state.scale * (event.deltaY > 0 ? 0.92 : 1.08))
			}

			/** Resize the pet, keeping its feet where they are. */
			setScale(value) {
				this.options.state.scale = clamp(value, SCALE_MIN, SCALE_MAX)
				this.#applyTransform()
				this.save()
			}

			// ------------------------------------------------------------ reactions

			/** Play one entry from a reaction pool plus a line from the matching pool. */
			#react(kind) {
				const pool = this.manifest.reactions?.[kind]
				if (!Array.isArray(pool) || pool.length === 0) return
				const entry = pool[Math.floor(Math.random() * pool.length)]
				this.#playEntry(entry)
				const lines = this.manifest.lines?.[kind]
				if (Array.isArray(lines) && lines.length > 0) {
					this.say(lines[Math.floor(Math.random() * lines.length)])
				}
			}

			/** Apply one catalogue entry: a motion, some expressions, or both. */
			#playEntry(entry) {
				if (typeof entry?.motion === 'string') this.playMotion(entry.motion)
				for (const name of entry?.expressions ?? []) {
					// Reactions are transient: they layer on top of the look and
					// fade out on their own.
					this.#flash(name, 2_600)
				}
			}

			/** Layer one expression over the look for a while. */
			#flash(name, ms) {
				this.flash = this.flash ?? new Map()
				const token = Symbol(name)
				this.flash.set(name, token)
				this.#applyLook()
				setTimeout(() => {
					if (this.flash?.get(name) !== token) return
					this.flash.delete(name)
					this.#applyLook()
				}, ms)
			}

			// --------------------------------------------------------------- looks

			/** Every slot id in the catalogue. */
			#slots() {
				return Array.isArray(this.manifest.slots) ? this.manifest.slots : []
			}

			/**
			 * The effective option label for one slot, or `undefined` for "none".
			 *
			 * Precedence is: a choice the user just made by hand, then the session
			 * phase, then their saved choice. The middle layer is why clicking a slot
			 * the phase has taken over used to do nothing at all.
			 */
			#selected(slotId) {
				const override = this.phaseOverrides[slotId]
				if (override !== undefined) return override
				const phase = this.phaseLook[slotId]
				if (phase !== undefined) return phase
				return this.userLook[slotId]
			}

			/** The catalogue entry for one option label. */
			#option(slotId, label) {
				const slot = this.#slots().find((candidate) => candidate.id === slotId)
				return (slot?.options ?? []).find((candidate) => candidate.label === label)
			}

			/** The slot that owns an option label, if any. */
			#slotOwning(label) {
				return this.#slots().find((slot) => (slot.options ?? []).some((option) => option.label === label))
			}

			/**
			 * Set (or clear) the user's choice for one slot.
			 *
			 * An option can mean three things in this catalogue, and all three have
			 * to happen: some expressions to hold, a motion to play (掏出手机,
			 * 自拍, 挤番茄酱, 吹泡泡糖 are *only* a motion), and prerequisites
			 * (`requires`) that have to be satisfied first — 自拍 needs the phone
			 * out, and the reference behaviour is to fetch it for you rather than
			 * silently do nothing.
			 *
			 * @param slotId - the slot being changed.
			 * @param label - the option label, or `undefined` for "none".
			 */
			setSlot(slotId, label) {
				if (label === undefined || label === null) {
					delete this.userLook[slotId]
					delete this.phaseOverrides[slotId]
				} else {
					this.userLook[slotId] = label
					// A hand-made choice beats the phase for this slot until the phase
					// changes, so the panel is never a dead end mid-conversation.
					if (this.phaseLook[slotId] !== undefined) this.phaseOverrides[slotId] = label
				}
				this.#applyLook()
				this.save()
				if (label !== undefined && label !== null) this.#runOption(slotId, label)
				this.#renderPanel()
			}

			/**
			 * Carry out an option's side effects: satisfy its prerequisites, then
			 * play the motion it stands for.
			 * @param slotId - the slot the option belongs to.
			 * @param label - the chosen option label.
			 * @param depth - recursion guard for prerequisite chains.
			 */
			#runOption(slotId, label, depth = 0) {
				const option = this.#option(slotId, label)
				if (option === undefined) return
				if (depth < 3) {
					for (const required of option.requires ?? []) {
						const owner = this.#slotOwning(required)
						if (owner === undefined || owner.id === slotId) continue
						if (this.#selected(owner.id) === required) continue
						this.userLook[owner.id] = required
						if (this.phaseLook[owner.id] !== undefined) this.phaseOverrides[owner.id] = required
						this.#runOption(owner.id, required, depth + 1)
					}
					this.#applyLook()
				}
				if (typeof option.motion === 'string') void this.playMotion(option.motion)
			}

			/** Let go of whatever the pet is holding, back to the idle loop. */
			releasePose() {
				this.releaseMotions()
				this.flash?.clear()
				this.#applyLook()
				this.#renderPanel()
			}

			/** Drop every user choice, keeping whatever a phase is currently showing. */
			resetLook() {
				for (const slotId of Object.keys(this.userLook)) delete this.userLook[slotId]
				this.phaseOverrides = {}
				this.#applyLook()
				this.save()
				this.#renderPanel()
			}

			/** Recompute the additive parameter set for the current look. */
			#applyLook() {
				const additive = new Map()
				const add = (id, value) => additive.set(id, (additive.get(id) ?? 0) + value)

				for (const slot of this.#slots()) {
					const label = this.#selected(slot.id)
					if (label === undefined) continue
					const option = (slot.options ?? []).find((candidate) => candidate.label === label)
					if (option === undefined) continue
					for (const name of option.expressions ?? []) {
						for (const parameter of this.expressionParameters.get(name) ?? []) {
							// Every expression in this model blends additively, so a
							// plain sum is the exact composition.
							add(parameter.id, parameter.value)
						}
					}
				}
				for (const name of this.flash?.keys() ?? []) {
					for (const parameter of this.expressionParameters.get(name) ?? []) {
						add(parameter.id, parameter.value)
					}
				}
				for (const [id, value] of this.preset) add(id, value)

				this.lookParameters = additive
				// Anything the model does not actually have is a catalogue/model
				// mismatch, and the kind of thing that hides: a write to an unknown
				// parameter is silently dropped, so the chip highlights and nothing
				// moves. Keeping the list makes that visible in `status()`.
				const core = this.model?.internalModel?.coreModel
				if (core === undefined) {
					this.unresolvedLookParameters = []
				} else {
					const index = this.#parameterIndex(core)
					this.unresolvedLookParameters = [...additive.keys()].filter((id) => !index.has(id))
				}
			}

			/**
			 * Parameter id -> index, built once per core model.
			 *
			 * The writes below have to go through the *index* API. The framework's
			 * `getParameterIndex()` does not resolve a plain string: asked for
			 * `"Paramhh2"` (index 200) it answers 249, which is past the end of a
			 * 247-parameter model, so `addParameterValueById("Paramhh2", …)` lands on
			 * a phantom array slot and changes nothing. Every look option was a
			 * silent no-op because of it — the chips highlighted, the model never
			 * moved.
			 * @param core - the Cubism core model wrapper.
			 * @returns the id -> index map for that model.
			 */
			#parameterIndex(core) {
				if (this.parameterIndexCache?.core === core) return this.parameterIndexCache.map
				const map = new Map()
				const count = core.getParameterCount()
				for (let index = 0; index < count; index += 1) {
					map.set(core.getParameterId(index).getString().s, index)
				}
				this.parameterIndexCache = { core, map }
				return map
			}

			/** Write the current look into the core model, once per frame. */
			#applyLookParameters() {
				if (this.lookParameters === undefined || this.lookParameters.size === 0) return
				const core = this.model.internalModel.coreModel
				const index = this.#parameterIndex(core)
				for (const [id, value] of this.lookParameters) {
					if (value === 0) continue
					const at = index.get(id)
					if (at === undefined) continue
					core.addParameterValueByIndex(at, value)
				}
			}

			// -------------------------------------------------------------- motions

			/**
			 * Play one motion group.
			 *
			 * `hold` freezes the motion on its last frame instead of letting the
			 * manager fall back to idle, `prepend` runs another group to its last
			 * frame first (the selfie needs the phone out), and `preset` pins a few
			 * parameters for as long as the pose is held.
			 *
			 * @param group - the motion group name from the catalogue.
			 * @param options - overrides taken from the catalogue entry.
			 */
			async playMotion(group, options = {}) {
				if (this.model === undefined) return
				const entry = this.manifest.motions?.[group] ?? {}
				const hold = options.hold ?? entry.hold ?? false
				// Clicking a frozen action again lets it go: without this the pose has
				// no release short of starting some other action, which reads as the
				// pet being stuck.
				if (hold && this.heldMotion === group && options.hold === undefined) {
					this.releaseMotions()
					this.#renderPanel()
					return
				}
				// Any previously frozen pose is given back before the next one starts.
				this.#stopMotions()
				this.preset.clear()
				if (entry.preset !== undefined) {
					for (const [id, value] of Object.entries(entry.preset)) this.preset.set(id, Number(value) || 0)
				}
				this.#applyLook()
				try {
					if (typeof entry.prepend === 'string') await this.model.motionLastFrame(entry.prepend, 0)
					if (hold) {
						this.heldMotion = group
						await this.model.motionLastFrame(group, 0)
					} else {
						this.heldMotion = undefined
						// `loop: false` is not optional here. Every motion in this model
						// declares `Loop: true` in its own JSON — including the one-shots
						// (重锤出击 / 自拍 / 掏出手机 / 喷水 …) — and the engine only
						// overrides that when `loop` is passed explicitly. Without it one
						// click started the hammer and it never stopped.
						//
						// Note there is no `onFinish` here: the engine accepts that option
						// and then throws it away (`_startMotion(motion, void 0, …)`), so
						// completion is picked up from the manager's own event instead —
						// see the subscription in `#loadModel`.
						await this.model.motion(group, 0, this.MotionPriority?.NORMAL ?? 2, { loop: false })
					}
				} catch {
					/* a missing motion group is a catalogue problem, not a crash */
				}
				this.#renderPanel()
			}

			/**
			 * Put every parameter back to its authored default.
			 *
			 * A motion only animates the parameters it names, and the engine saves
			 * each frame's motion output as the next frame's base — so a one-shot
			 * motion that raises the hammer leaves `Param71` ("hammer visible") at 1
			 * forever, because the idle loop never touches it. Measured on this
			 * model, seven seconds after a one-shot finishes: 重锤出击 leaves 4
			 * parameters outside the idle band (the hammer is still on screen),
			 * 快速自拍 leaves 6 (the phone is still in her hand), 挤番茄酱 leaves 13.
			 *
			 * This is why "the action stays after it finishes" is a real defect
			 * rather than a design choice. Resetting in the motion's own finish
			 * callback lands before the idle motion is applied and before the
			 * engine saves the new base, so the pet returns to neutral and the
			 * look, focus, and physics that are written every frame come straight
			 * back.
			 */
			#resetPose() {
				const core = this.model?.internalModel?.coreModel
				if (core === undefined) return
				const count = core.getParameterCount()
				// The framework exposes the authored defaults by index; the raw core
				// model carries the same array, and is the fallback for a build that
				// does not surface the helper.
				if (typeof core.getParameterDefaultValue === 'function' && typeof core.setParameterValueByIndex === 'function') {
					for (let index = 0; index < count; index += 1) {
						core.setParameterValueByIndex(index, core.getParameterDefaultValue(index))
					}
					return
				}
				const parameters = core.getModel?.()?.parameters
				if (parameters?.defaultValues === undefined) return
				for (let index = 0; index < count; index += 1) {
					parameters.values[index] = parameters.defaultValues[index]
				}
			}

			/** Let go of every pose and preset, returning the pet to its idle loop. */
			releaseMotions() {
				this.#stopMotions()
				this.heldMotion = undefined
				this.#resetPose()
				if (this.preset.size > 0) {
					this.preset.clear()
					this.#applyLook()
				}
			}

			#stopMotions() {
				try {
					this.model?.internalModel.motionManager.stopAllMotions()
				} catch {
					/* nothing was playing */
				}
			}

			// ----------------------------------------------------------------- phases

			/**
			 * Follow the host's phase stream. A phase may name slots — those win
			 * over the user's choice while it lasts, and give way again when the
			 * session returns to `idle`.
			 */
			#subscribePhase() {
				if (typeof EventSource !== 'function') return
				const source = new EventSource(absoluteUrl(this.catalog.events))
				this.eventSource = source
				source.addEventListener('message', (event) => {
					let payload
					try {
						payload = JSON.parse(event.data)
					} catch {
						return
					}
					this.applyPhase(payload?.phase)
				})
				this.disposers.push(() => source.close())
				this.applyPhase(this.catalog.phase?.phase)
			}

			/** Enter a phase: swap the phase look, motion, and line. */
			applyPhase(phase) {
				if (typeof phase !== 'string') return
				if (this.phase === phase) return
				this.phase = phase
				const definition = this.manifest.phases?.[phase] ?? {}
				this.phaseLook = phase === 'idle' ? {} : { ...(definition.slots ?? {}) }
				// A phase change is a fresh takeover, so hand-made overrides from the
				// previous phase expire with it.
				this.phaseOverrides = {}
				if (phase === 'idle') {
					// The session is over: give the body back to the user's look and
					// let the idle loop resume.
					this.releaseMotions()
				} else {
					if (typeof definition.motion === 'string') void this.playMotion(definition.motion)
					if (typeof definition.line === 'string') this.say(definition.line)
				}
				this.#applyLook()
				this.#renderPanel()
			}

			// ---------------------------------------------------------------- bubble

			/** Show one line above the pet for a few seconds. */
			say(text) {
				if (this.options.state.bubble === false) return
				if (typeof text !== 'string' || text.length === 0) return
				this.bubble.textContent = text
				this.bubble.style.opacity = '1'
				this.bubble.style.transform = 'translate(-50%,0) scale(1)'
				clearTimeout(this.bubbleTimer)
				this.bubbleTimer = setTimeout(() => {
					this.bubble.style.opacity = '0'
					this.bubble.style.transform = 'translate(-50%,0) scale(0.9)'
				}, BUBBLE_MS)
			}

			#announce() {
				const lines = this.manifest.lines?.greet
				if (Array.isArray(lines) && lines.length > 0) {
					this.say(lines[Math.floor(Math.random() * lines.length)])
				}
			}

			// ----------------------------------------------------------------- layout

			/** Keep the pet on screen. */
			#clampPosition() {
				const maxX = Math.max(0, window.innerWidth - this.stageSize.width)
				const maxY = Math.max(0, window.innerHeight - this.stageSize.height)
				this.options.state.x = clamp(this.options.state.x, 0, maxX)
				this.options.state.y = clamp(this.options.state.y, 0, maxY)
			}

			#placeStage() {
				this.stage.style.transform = `translate3d(${Math.round(this.options.state.x)}px,${Math.round(this.options.state.y)}px,0)`
			}

			/** Put the pet in the bottom-right corner for its current size. */
			#placeDefault() {
				this.options.state.x = Math.max(0, window.innerWidth - this.stageSize.width - DEFAULT_MARGIN)
				this.options.state.y = Math.max(0, window.innerHeight - this.stageSize.height - DEFAULT_MARGIN)
				this.#placeStage()
			}

			/** Snap back to the default corner and size. */
			resetPosition() {
				this.options.state.scale = DEFAULT_SCALE
				this.#applyTransform()
				this.#placeDefault()
				this.save()
				this.#sayResetLine()
			}

			/**
			 * Put the pet back the way it starts: default size in the default
			 * corner, no frozen pose, and no look selections.
			 *
			 * This is the one button that has to mean "undo everything I did".
			 * Resetting only the geometry left a chosen outfit and a frozen action
			 * in place, which reads as the reset not having worked.
			 */
			resetEverything() {
				this.releaseMotions()
				this.flash?.clear()
				for (const slotId of Object.keys(this.userLook)) delete this.userLook[slotId]
				this.phaseOverrides = {}
				this.#applyLook()
				this.options.state.scale = DEFAULT_SCALE
				this.#applyTransform()
				this.#placeDefault()
				this.save()
				this.#renderPanel()
				this.#sayResetLine()
			}

			#sayResetLine() {
				const lines = this.manifest.lines?.reset
				if (Array.isArray(lines) && lines.length > 0) this.say(lines[Math.floor(Math.random() * lines.length)])
			}

			// ------------------------------------------------------------------ panel

			/** Show or hide the control panel. */
			togglePanel(force) {
				const open = force ?? this.panel.style.display !== 'block'
				this.panel.style.display = open ? 'block' : 'none'
				if (open) this.#renderPanel()
			}

			#buildPanel() {
				const panel = document.createElement('div')
				panel.className = 'dsh-pet-panel'
				panel.style.cssText = [
					'position:absolute',
					'left:0',
					'top:0',
					'width:264px',
					'max-height:min(560px,80vh)',
					'overflow:auto',
					'padding:10px',
					'border-radius:14px',
					// DSH theme tokens: the panel is a popover in the app's own scheme.
					'background:var(--dsw-alias-bg-layer-1,rgba(24,24,28,0.97))',
					'color:var(--dsw-alias-label-primary,#f2f2f4)',
					'font:400 12px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
					'box-shadow:0 12px 40px rgba(0,0,0,0.28)',
					'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.1))',
					'pointer-events:auto',
					'display:none',
					'z-index:3',
				].join(';')
				panel.addEventListener('pointerdown', (event) => event.stopPropagation())
				panel.addEventListener('contextmenu', (event) => event.preventDefault())
				this.panel = panel
				this.stage.appendChild(panel)
			}

			/** Repaint the panel's contents from the current state. */
			#renderPanel() {
				if (this.panel === undefined) return
				const panel = this.panel
				panel.textContent = ''

				const title = document.createElement('div')
				title.textContent = this.manifest.displayName ?? this.catalog.petId
				title.style.cssText = 'font-weight:600;font-size:13px;margin:0 0 8px'
				panel.appendChild(title)

				panel.appendChild(this.#section('动作', () => {
					const grid = document.createElement('div')
					grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px'
					for (const [group, entry] of Object.entries(this.manifest.motions ?? {})) {
						if (entry?.hidden === true) continue
						const held = this.heldMotion === group
						const button = this.#button(entry?.label ?? group, () => {
							void this.playMotion(group)
							if (entry?.hold !== true) this.togglePanel(false)
						})
						if (entry?.hold === true) {
							// Frozen actions are the ones that look "stuck" if nothing says
							// so: they hold their last frame until released. Say it on the
							// button, and make the button itself the release.
							button.title = held ? '再点一次放手' : '定格动作：会停在最后一帧，再点一次放手'
							const tag = document.createElement('span')
							tag.textContent = held ? ' 放手' : ' 定格'
							tag.style.cssText = 'opacity:0.55;font-size:10px'
							button.appendChild(tag)
							if (held) {
								button.style.borderColor = 'var(--dsw-alias-brand-primary,#3b82f6)'
							}
						}
						grid.appendChild(button)
					}
					return grid
				}))

				panel.appendChild(this.#section('装扮', () => {
					const list = document.createElement('div')
					list.style.cssText = 'display:flex;flex-direction:column;gap:8px'
					for (const slot of this.#slots()) {
						const row = document.createElement('div')
						const head = document.createElement('div')
						head.textContent = slot.label ?? slot.id
						head.style.cssText = 'opacity:0.65;margin-bottom:3px'
						row.appendChild(head)
						const chips = document.createElement('div')
						chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px'
						const selected = this.#selected(slot.id)
						const phaseOwned = this.phaseLook[slot.id] !== undefined
						chips.appendChild(this.#chip(slot.none ?? '无', selected === undefined, () => this.setSlot(slot.id, undefined)))
						for (const option of slot.options ?? []) {
							const chip = this.#chip(option.label, selected === option.label, () => this.setSlot(slot.id, option.label))
							if (typeof option.motion === 'string') {
								chip.title = '这个选项会播一段动作'
								const dot = document.createElement('span')
								dot.textContent = ' ▸'
								dot.style.cssText = 'opacity:0.55;font-size:10px'
								chip.appendChild(dot)
							}
							if (Array.isArray(option.requires) && option.requires.length > 0) {
								chip.title = `会自动先选上：${option.requires.join('、')}`
							}
							chips.appendChild(chip)
						}
						row.appendChild(chips)
						if (phaseOwned) {
							const note = document.createElement('div')
							note.textContent = '会话接管中 —— 点一下可以临时改成你选的'
							note.style.cssText = 'opacity:0.5;margin-top:3px;font-size:11px'
							row.appendChild(note)
						}
						list.appendChild(row)
					}
					return list
				}))

				panel.appendChild(this.#section('外观', () => {
					const box = document.createElement('div')
					box.style.cssText = 'display:flex;flex-direction:column;gap:8px'

					const slider = document.createElement('input')
					slider.type = 'range'
					slider.min = String(SCALE_MIN)
					slider.max = String(SCALE_MAX)
					slider.step = '0.01'
					slider.value = String(this.options.state.scale)
					slider.style.width = '100%'
					slider.addEventListener('input', () => {
						this.options.state.scale = Number(slider.value)
						this.#applyTransform()
					})
					slider.addEventListener('change', () => this.save())
					box.appendChild(slider)

					const row = document.createElement('div')
					row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap'
					row.appendChild(this.#button(this.options.state.bubble === false ? '开气泡' : '关气泡', () => {
						this.options.state.bubble = this.options.state.bubble === false
						this.save()
						this.#renderPanel()
					}))
					// One button that undoes everything: size and position back to the
					// default, frozen action released, look cleared. The two narrower
					// resets stay beside it for when only one of those is wanted.
					const reset = this.#button('复位', () => this.resetEverything())
					reset.title = `回到默认大小与位置，并清空动作和装扮（默认大小 ${Math.round(DEFAULT_SCALE * 100)}%）`
					reset.style.fontWeight = '600'
					row.appendChild(reset)
					box.appendChild(row)

					const row2 = document.createElement('div')
					row2.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap'
					row2.appendChild(this.#button('清空装扮', () => this.resetLook()))
					const release = this.#button('松手', () => this.releasePose())
					release.title = '放开定格的动作，回到待机'
					if (this.heldMotion === undefined) release.style.opacity = '0.5'
					row2.appendChild(release)
					box.appendChild(row2)

					const row3 = document.createElement('div')
					row3.style.cssText = 'display:flex;gap:6px'
					row3.appendChild(this.#button('隐藏', () => this.setHidden(true)))
					row3.appendChild(this.#button('关闭面板', () => this.togglePanel(false)))
					box.appendChild(row3)
					return box
				}))

				this.#placePanel()
			}

			#section(label, build) {
				const section = document.createElement('div')
				section.style.cssText = 'margin-bottom:12px'
				const head = document.createElement('div')
				head.textContent = label
				head.style.cssText = 'font-weight:600;opacity:0.9;margin-bottom:6px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.09));padding-top:8px'
				section.appendChild(head)
				section.appendChild(build())
				return section
			}

			#button(label, onClick) {
				const button = document.createElement('button')
				button.type = 'button'
				button.textContent = label
				button.style.cssText = [
					'font:inherit',
					'padding:4px 9px',
					'border-radius:8px',
					'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.16))',
					'background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.07))',
					'color:inherit',
					'cursor:pointer',
				].join(';')
				button.addEventListener('click', (event) => {
					event.stopPropagation()
					onClick()
				})
				return button
			}

			#chip(label, active, onClick) {
				const chip = this.#button(label, onClick)
				if (active) {
					// `brand-primary` is a *foreground* accent in DSH: it is a blue in
					// the light theme and near-white in the dark one. Pairing it with
					// the base background keeps the label readable in both, which a
					// hardcoded white label would not.
					chip.style.background = 'var(--dsw-alias-brand-primary,#3b82f6)'
					chip.style.borderColor = 'var(--dsw-alias-brand-primary,#3b82f6)'
					chip.style.color = 'var(--dsw-alias-bg-base,#fff)'
					chip.style.fontWeight = '600'
				}
				return chip
			}

			/** Keep the panel inside the viewport, flipping above the pet if needed. */
			#placePanel() {
				if (this.panel === undefined) return
				const width = 264
				const height = this.panel.offsetHeight || 320
				const left = clamp(this.options.state.x + this.stageSize.width - width, 8, window.innerWidth - width - 8)
				const below = this.options.state.y + this.stageSize.height * 0.4
				const top = below + height > window.innerHeight - 8
					? Math.max(8, this.options.state.y - height - 8)
					: below
				this.panel.style.left = `${Math.round(left - this.options.state.x)}px`
				this.panel.style.top = `${Math.round(top - this.options.state.y)}px`
			}

			// ------------------------------------------------------------------ misc

			/**
			 * Show or hide the pet without unmounting it.
			 *
			 * Hiding is persisted, so it needs a way back that does not live inside
			 * the thing being hidden — that is the sidebar toggle, and this reports
			 * the new state to it.
			 * @param hidden - the new visibility.
			 */
			setHidden(hidden) {
				this.options.state.hidden = hidden
				this.host.style.display = hidden ? 'none' : ''
				this.save()
				publishPetState({ available: true, hidden })
			}

			save() {
				try {
					this.options.storage.setItem(STORAGE_KEY, JSON.stringify(this.options.state))
				} catch {
					/* a full or unavailable store is not worth failing over */
				}
			}

			/** Publish a diagnostics handle the browser tests and users can read. */
			#publishDiagnostics() {
				globalThis.__dshDesktopPet = {
					pet: this,
					status: () => ({
						phase: this.phase,
						scale: this.options.state.scale,
						position: { x: this.options.state.x, y: this.options.state.y },
						slots: this.#slots().map((slot) => ({ id: slot.id, selected: this.#selected(slot.id) })),
						lookParameters: Object.fromEntries(this.lookParameters ?? []),
						/** Look parameters the model does not have; empty is healthy. */
						unresolvedLookParameters: this.unresolvedLookParameters ?? [],
						visible: this.host.style.display !== 'none',
					}),
					hitAt: (clientX, clientY) => {
						const rect = this.canvas.getBoundingClientRect()
						return this.#hitTest(clientX - rect.left, clientY - rect.top)
					},
					model: () => this.model,
					root: () => this.host,
				}
			}

			start() {
				this.#buildDom()
				this.#buildPanel()
				this.#publishDiagnostics()
				this.#placeStage()
				this.host.style.display = this.options.state.hidden === true ? 'none' : ''
				return this.mount().then(() => {
					// The surface only knows its real size once the model has loaded,
					// so the first-run corner is settled here.
					if (this.options.state.x === null || this.options.state.y === null) this.#placeDefault()
					else this.#clampPosition()
					this.#placeStage()
				})
			}

			destroy() {
				this.destroyed = true
				for (const dispose of this.disposers.splice(0)) {
					try {
						dispose()
					} catch {
						/* teardown must not throw */
					}
				}
				clearTimeout(this.bubbleTimer)
				clearTimeout(this.clickTimer)
				try {
					this.eventSource?.close()
				} catch {
					/* already closed */
				}
				try {
					this.model?.destroy()
				} catch {
					/* already gone */
				}
				try {
					this.app?.destroy({ removeView: true }, { children: true, texture: false, textureSource: false })
				} catch {
					/* already gone */
				}
				if (globalThis.__dshDesktopPet?.pet === this) delete globalThis.__dshDesktopPet
				this.stage?.remove()
			}
		}

		// ------------------------------------------------------------------ helpers

		/** Clamp a number into a range. */
		function clamp(value, min, max) {
			return value < min ? min : value > max ? max : value
		}

		/**
		 * Flatten an error's `cause` chain into one line. Library errors are often
		 * a generic wrapper around the only interesting sentence.
		 * @param error - the caught value.
		 * @returns a readable summary, or an empty string when there is no cause.
		 */
		function describeCause(error) {
			const parts = []
			let current = error?.cause
			for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
				parts.push(String(current?.message ?? current))
				current = current?.cause
			}
			return parts.join(' <- ')
		}

		/**
		 * Read the persisted state, tolerating anything a previous version left.
		 *
		 * A missing position stays `null` rather than being guessed here: the real
		 * surface size is only known once the model has loaded, and the default
		 * corner has to be computed from that.
		 */
		function readState(storage) {
			let stored = {}
			try {
				stored = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') ?? {}
			} catch {
				stored = {}
			}
			const scale = Number(stored.scale)
			const x = Number(stored.x)
			const y = Number(stored.y)
			return {
				x: Number.isFinite(x) ? x : null,
				y: Number.isFinite(y) ? y : null,
				scale: resolveScale(stored, scale),
				// Marks that `scale` is a deliberate choice from now on, so a later
				// change to the shipped default cannot silently move it again.
				scaleVersion: SCALE_VERSION,
				bubble: stored.bubble !== false,
				hidden: stored.hidden === true,
				look: stored.look !== null && typeof stored.look === 'object' ? stored.look : {},
			}
		}

		/**
		 * Pick the scale to start with.
		 *
		 * A state saved before `scaleVersion` existed has a scale the user most
		 * likely never chose — it is just whatever the old default was. Moving
		 * exactly that value to the new default makes "the default is smaller now"
		 * true on the next load instead of only for fresh installs, while any other
		 * value is left alone.
		 *
		 * @param stored - the raw persisted state.
		 * @param scale - the persisted scale, already coerced to a number.
		 * @returns the scale to use.
		 */
		function resolveScale(stored, scale) {
			if (!Number.isFinite(scale)) return DEFAULT_SCALE
			if (stored.scaleVersion === undefined && scale === LEGACY_DEFAULT_SCALE) return DEFAULT_SCALE
			return clamp(scale, SCALE_MIN, SCALE_MAX)
		}

		// ------------------------------------------------------------------ plugin

		const name = 'desktop-pet'
		/** `slots` carries the sidebar toggle, the pet's way back once hidden. */
		const inject = ['slots']

		// ------------------------------------------------- the sidebar toggle

		/**
		 * Visibility as the sidebar toggle sees it, plus a subscription so the
		 * button re-renders when the pet's own panel changes it.
		 */
		let petState = { available: false, hidden: false }
		const petStateListeners = new Set()

		/** Publish a new pet state to every mounted toggle. */
		function publishPetState(next) {
			if (petState.available === next.available && petState.hidden === next.hidden) return
			petState = next
			for (const listener of petStateListeners) {
				try {
					listener(petState)
				} catch {
					/* one broken subscriber must not stop the others */
				}
			}
		}

		/** The live pet, so the toggle has something to act on. */
		let currentPet

		/** Show or hide the pet from outside its own panel. */
		function togglePetVisibility() {
			if (currentPet === undefined) return
			currentPet.setHidden(!currentPet.options.state.hidden)
		}

		/**
		 * The sidebar-foot button.
		 *
		 * It lives in `sidebar.footer.action`, a documented extension seat beside
		 * Settings, precisely because it has to stay reachable while the pet
		 * itself is hidden — and because `hidden` is persisted, "hide" with no
		 * visible way back is a trap the user cannot climb out of.
		 */
		function PetToggle(props) {
			const state = usePetState()
			const wide = props?.wide !== false
			const label = state.hidden ? '显示桌宠' : '隐藏桌宠'
			const children = [
				react.createElement('span', { key: 'icon', className: 'dsh-pet-toggle-icon', 'aria-hidden': 'true' }, '🐋'),
			]
			if (wide) children.push(react.createElement('span', { key: 'label', className: 'dsh-pet-toggle-label' }, label))
			return react.createElement(
				'button',
				{
					type: 'button',
					className: 'dsh-pet-toggle',
					title: state.available ? label : '桌宠尚未加载',
					disabled: !state.available,
					'aria-pressed': state.hidden,
					onClick: togglePetVisibility,
				},
				children,
			)
		}

		/** Subscribe a component to the pet's visibility. */
		function usePetState() {
			const [state, setState] = react.useState(petState)
			react.useEffect(() => {
				petStateListeners.add(setState)
				// The state may have changed between render and subscribe.
				setState(petState)
				return () => petStateListeners.delete(setState)
			}, [])
			return state
		}

		/** The toggle's own styles, injected once and scoped to its class. */
		const TOGGLE_STYLE_ID = 'dsh-desktop-pet-toggle-style'
		function installToggleStyles() {
			if (document.getElementById(TOGGLE_STYLE_ID) !== null) return
			const style = document.createElement('style')
			style.id = TOGGLE_STYLE_ID
			style.textContent = `
.dsh-pet-toggle {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 6px 8px;
  background: transparent; border: 0; border-radius: 8px;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font: inherit; text-align: left; cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.dsh-pet-toggle:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12));
  color: var(--dsw-alias-label-primary, #111827);
}
.dsh-pet-toggle:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6);
  outline-offset: 1px;
}
.dsh-pet-toggle:disabled { opacity: 0.5; cursor: default; }
.dsh-pet-toggle-icon { font-size: 14px; line-height: 1; }
.dsh-pet-toggle-label { font-size: 13px; white-space: nowrap; }
`
			document.head.appendChild(style)
		}

		/** Fetch the host catalogue, or throw with something readable. */
		async function fetchCatalog() {
			const response = await fetch(absoluteUrl(`${API}/catalog`), { cache: 'no-store' })
			if (!response.ok) throw new Error(`the desktop-pet host route answered ${response.status}`)
			const catalog = await response.json()
			if (catalog.ok !== true) throw new Error(catalog.error ?? 'the desktop pet could not be read')
			return catalog
		}

		/** One floating pet per page, whoever mounts last wins. */
		function apply(ctx) {
			for (const stale of Array.from(document.querySelectorAll(`[${ROOT_ATTR}]`))) stale.remove()

			const storage = createStorage()
			// Anything that escapes while the pet is booting is worth keeping: a
			// script that loads but dies raises here, not in a rejected promise.
			const uncaught = []
			const onUncaught = (event) => {
				uncaught.push(String(event?.message ?? event?.error ?? 'unknown error'))
			}
			window.addEventListener('error', onUncaught)

			// Watch the URLs the renderer hands to its image worker for the duration
			// of the boot, then put the prototype back. Textures are decoded off the
			// main thread, and a URL that resolves correctly on one origin and not
			// another shows up here first.
			const workerUrls = []
			const originalPostMessage = Worker.prototype.postMessage
			Worker.prototype.postMessage = function patchedPostMessage(message, ...rest) {
				try {
					const first = message?.data?.[0]
					if (typeof first === 'string' && workerUrls.length < 16) workerUrls.push(first)
				} catch {
					/* a message shape we do not understand is not our business */
				}
				return originalPostMessage.call(this, message, ...rest)
			}
			const stopTracingUrls = () => {
				Worker.prototype.postMessage = originalPostMessage
			}

			const host = document.createElement('div')
			host.setAttribute(ROOT_ATTR, '')
			host.style.cssText = [
				'position:fixed',
				'inset:0',
				'z-index:2147483000',
				'pointer-events:none',
				'overflow:visible',
			].join(';')
			document.body.appendChild(host)

			let pet
			let catalog
			const boot = (async () => {
				globalThis.__dshDesktopPetStage = 'catalog'
				catalog = await fetchCatalog()
				if (!host.isConnected) return
				globalThis.__dshDesktopPetStage = 'construct'
				pet = new DesktopPet(host, catalog, { storage, state: readState(storage), ctx })
				currentPet = pet
				publishPetState({ available: true, hidden: pet.options.state.hidden === true })
				globalThis.__dshDesktopPetStage = 'start'
				await pet.start()
				globalThis.__dshDesktopPetStage = 'mounted'
				stopTracingUrls()
				// A mount that worked clears the record of the one that did not, and
				// leaves behind the URLs it used.
				try {
					storage.removeItem(ERROR_KEY)
					storage.setItem(URLS_KEY, JSON.stringify({
						at: new Date().toISOString(),
						pageUrl: location.href,
						baseURI: document.baseURI,
						catalogModel: catalog.model,
						modelSource: pet.modelSource ?? null,
						workerUrls,
					}))
				} catch {
					/* nothing to record */
				}
				ctx.logger?.info?.('desktop-pet: mounted')
			})().catch((error) => {
				const message = String(error?.message ?? error)
				stopTracingUrls()
				globalThis.__dshDesktopPetError = `${error?.name ?? 'Error'}: ${message}\n${error?.stack ?? ''}`
				ctx.logger?.warn?.(`desktop-pet: ${message}`)
				const record = {
					at: new Date().toISOString(),
					stage: globalThis.__dshDesktopPetStage ?? 'unknown',
					url: typeof location === 'undefined' ? '' : location.href,
					message,
					// Libraries wrap the real reason in `cause`; without it the record
					// only ever says "something failed to start".
					cause: describeCause(error),
					uncaught: uncaught.slice(0, 4),
					pageUrl: typeof location === 'undefined' ? '' : location.href,
					baseURI: typeof document === 'undefined' ? '' : document.baseURI,
					catalogModel: catalog?.model ?? null,
					modelSource: pet?.modelSource ?? null,
					workerUrls,
					userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
					stack: String(error?.stack ?? '').split('\n').slice(0, 6).join('\n'),
				}
				try {
					storage.setItem(ERROR_KEY, JSON.stringify(record))
				} catch {
					/* a store that cannot be written is not worth failing twice over */
				}
				globalThis.__dshDesktopPetLastError = record
				const lines = catalog?.manifest?.lines ?? {}
				// A missing Cubism Core is the one failure the user can fix, and only
				// they can, so it gets its own wording. Either way the rest of the
				// GUI is left alone: a broken pet must not take the app with it.
				const coreMissing = message.includes('Cubism Core')
				showNotice(
					(coreMissing ? lines.coreMissing?.[0] : lines.loadFailed?.[0])
						?? (coreMissing ? '桌宠：缺少 Live2D Cubism Core 运行时' : '桌宠：加载失败'),
					// The reason goes on screen too: a screenshot is then enough to
					// diagnose it, without anyone opening a console.
					`${record.stage}: ${message}`,
				)
				host.remove()
			})

			/** A small self-dismissing toast, themed like the rest of the pet. */
			function showNotice(text, detail) {
				const notice = document.createElement('div')
				notice.setAttribute(ROOT_ATTR, '')
				const title = document.createElement('div')
				title.textContent = text
				const reason = document.createElement('div')
				reason.textContent = detail.length > 220 ? `${detail.slice(0, 220)}…` : detail
				reason.style.cssText = 'margin-top:4px;opacity:0.7;font-weight:400;font-size:11px;max-width:420px;word-break:break-word'
				notice.append(title, reason)
				notice.title = detail
				notice.style.cssText = [
					'position:fixed',
					'right:16px',
					'bottom:16px',
					'z-index:2147483000',
					'padding:8px 12px',
					'border-radius:10px',
					'background:var(--dsw-alias-bg-layer-1,rgba(24,24,28,0.95))',
					'color:var(--dsw-alias-label-primary,#f2f2f4)',
					'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.12))',
					'font:500 12px/1.4 system-ui,sans-serif',
					'box-shadow:0 8px 24px rgba(0,0,0,0.25)',
				].join(';')
				document.body.appendChild(notice)
				setTimeout(() => notice.remove(), 20_000)
			}

			// The sidebar toggle. Registered through `slots.inject` because the
			// sidebar renders lazily, and wrapped so that a slot contract this
			// plugin gets wrong can never take the pet down with it.
			try {
				if (react !== undefined && ctx.slots !== undefined && ctx.slots !== null) {
					installToggleStyles()
					ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
						name: 'sidebar.footer.action',
						id: 'desktop-pet',
						order: 50,
						label: () => (petState.hidden ? '显示桌宠' : '隐藏桌宠'),
					}, PetToggle))
				}
			} catch (error) {
				ctx.logger?.warn?.(`desktop-pet: sidebar toggle unavailable: ${error?.message ?? error}`)
			}

			ctx.effect(() => () => {
				void boot
				window.removeEventListener('error', onUncaught)
				pet?.destroy()
				host.remove()
				if (currentPet === pet) currentPet = undefined
				publishPetState({ available: false, hidden: false })
			}, 'desktop-pet: client lifecycle')
		}

		exports.name = name
		exports.inject = inject
		exports.apply = apply
		return module.exports
	},
})
