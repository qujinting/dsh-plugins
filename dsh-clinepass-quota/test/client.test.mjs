import { test } from 'node:test'
import assert from 'node:assert/strict'

test('浏览器半边：模块工厂可执行，缺 React 时只降级不抛', async () => {
	let captured
	globalThis.window = {
		__ModuleLoader__: { load: (definition) => { captured = definition } },
		location: { href: 'http://127.0.0.1:65154/' },
		addEventListener: () => {},
		removeEventListener: () => {},
	}
	try {
		await import('../lib/client.js')
		assert.ok(captured !== undefined, '客户端模块应当向 __ModuleLoader__ 注册自己')
		assert.equal(captured.id, 'dsh-clinepass-quota')

		const exported = captured.factory(() => {
			throw new Error('react is not seeded in this test')
		})
		assert.equal(exported.name, 'clinepass-quota')
		assert.deepEqual(exported.inject, ['slots'])
		assert.equal(typeof exported.apply, 'function')
		assert.equal(typeof exported.SettingsSection, 'function')
		assert.equal(typeof exported.HeaderQuotaBadge, 'function')

		const warnings = []
		exported.apply({ logger: { warn: (message) => warnings.push(message) } })
		assert.equal(warnings.length, 1)
		assert.match(warnings[0], /React 不可用/u)
	} finally {
		delete globalThis.window
	}
})
