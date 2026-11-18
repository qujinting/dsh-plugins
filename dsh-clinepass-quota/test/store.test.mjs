import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { KeyStore, maskKey, resolveKey } from '../src/store.js'

test('maskKey 只露头尾，短 key 全遮', () => {
	assert.equal(maskKey(''), '')
	assert.equal(maskKey('short'), '•••••')
	assert.equal(maskKey('cpk_abcdefghijklmnop1234'), 'cpk_ab••••••1234')
	assert.equal(maskKey('a'.repeat(40)).includes('•'), true)
})

test('KeyStore 只读：读到手工放置的文件，不写任何东西', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'cpq-store-'))
	try {
		// 空目录 → 没有条目，也不算错误。
		const empty = new KeyStore({ dataDir: dir })
		await empty.ready
		assert.equal(empty.entry, undefined)
		assert.equal(empty.problem, undefined)

		// 插件自己从不创建文件，但手工放一个能被读到。
		await writeFile(path.join(dir, 'credentials.json'), JSON.stringify({ apiKey: 'cpk_0123456789', updatedAt: '2026-11-18T00:00:00.000Z' }), 'utf8')
		const store = new KeyStore({ dataDir: dir })
		await store.ready
		assert.equal(store.entry.apiKey, 'cpk_0123456789')

		// 坏 JSON 只记 problem，不抛。
		await writeFile(path.join(dir, 'credentials.json'), '{ not json', 'utf8')
		const broken = new KeyStore({ dataDir: dir })
		await broken.ready
		assert.equal(broken.entry, undefined)
		assert.match(broken.problem, /读取/u)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('resolveKey：环境变量优先于兜底文件，空白环境变量视为未设置', () => {
	const stored = { apiKey: 'from-file-key', updatedAt: '' }
	const envNames = ['CLINEPASS_API_KEY', 'CLINE_API_KEY']

	assert.deepEqual(
		resolveKey({ envNames, env: { CLINEPASS_API_KEY: 'from-env-key' }, stored }),
		{ apiKey: 'from-env-key', source: 'env', sourceDetail: '环境变量 CLINEPASS_API_KEY' },
	)
	assert.deepEqual(
		resolveKey({ envNames, env: { CLINE_API_KEY: 'second-env-key' }, stored }),
		{ apiKey: 'second-env-key', source: 'env', sourceDetail: '环境变量 CLINE_API_KEY' },
	)
	assert.equal(resolveKey({ envNames, env: {}, stored }).source, 'file')
	assert.match(resolveKey({ envNames, env: {}, stored }).sourceDetail, /手工放置/u)
	assert.equal(resolveKey({ envNames, env: {}, stored: undefined }).source, 'missing')
	assert.equal(resolveKey({ envNames, env: { CLINEPASS_API_KEY: '   ' }, stored }).source, 'file')
})
