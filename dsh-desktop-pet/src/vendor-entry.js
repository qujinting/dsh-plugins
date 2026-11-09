/**
 * Vendor bundle entry — the Live2D rendering stack the pet surface needs.
 *
 * esbuild compiles this to an IIFE that publishes `window.__dshPetVendor`.
 * The client half injects it lazily, only once a pet is actually mounted, so
 * the first paint of the DSH GUI never pays for it.
 *
 * Both dependencies are MIT-licensed and therefore redistributable inside this
 * plugin:
 *
 *   pixi.js                        — MIT
 *   untitled-pixi-live2d-engine    — MIT
 *
 * The proprietary Cubism Core runtime (`live2dcubismcore.min.js`) is NEVER
 * bundled here: the host half proxies it from Live2D's official CDN and caches
 * it locally, and the client half installs it as `window.Live2DCubismCore`
 * before this bundle is asked to load a model.
 */
import { Application, Point, Rectangle, extensions } from 'pixi.js'
import {
	MotionPriority,
	configureCubismSDK,
	Live2DModel,
	Live2DPlugin,
} from 'untitled-pixi-live2d-engine/cubism'

globalThis.__dshPetVendor = {
	Application,
	Point,
	Rectangle,
	extensions,
	MotionPriority,
	configureCubismSDK,
	Live2DModel,
	Live2DPlugin,
}
