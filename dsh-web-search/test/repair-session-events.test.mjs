/**
 * Unit tests for the session-log repair tool: detection, rewriting, framing,
 * and the guards that keep it away from a live session.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { adoptSessionEvent, KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import {
	decodeSessionFile,
	findUnsupportedEvents,
	listSessionFiles,
	markUnsupportedIgnorable,
	repairSessionFile,
	scanSessionFile,
} from '../tools/repair-session-events.mjs';

const ZSTD_CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const SESSION_FILE = 'session.v' + String(SESSION_FORMAT_VERSION) + '.jsonl.zstd';

const HEADER = { type: 'session', version: SESSION_FORMAT_VERSION, id: 'session-test', createdAt: 1, isSeeded: false, delegationDepth: 0 };
const KNOWN_EVENT = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } };
const CUSTOM_EVENT = { type: 'web/clinepass-search-request', seq: 1, time: 2, data: { query: 'x' } };
const MARKED_EVENT = { type: 'web/legacy-event', seq: 2, time: 3, data: {}, ignorable: true };

function frame(value) {
	return zlib.zstdCompressSync(Buffer.from(value, 'utf8'), ZSTD_CHECKSUM);
}

/** One frame per line, exactly the way the harness batches appends. */
function writeLog(dir, records, name = SESSION_FILE) {
	const file = path.join(dir, name);
	fs.writeFileSync(file, Buffer.concat(records.map((record) => frame(JSON.stringify(record) + '\n'))));
	return file;
}

function temporaryDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-repair-test-'));
}

test('findUnsupportedEvents skips the header, known types, and marked events', () => {
	const text = [HEADER, KNOWN_EVENT, CUSTOM_EVENT, MARKED_EVENT].map((record) => JSON.stringify(record)).join('\n') + '\n';
	assert.deepEqual(findUnsupportedEvents(text), [{ lineIndex: 2, type: 'web/clinepass-search-request', seq: 1 }]);
});

test('markUnsupportedIgnorable marks only the offending envelope', () => {
	const lines = [JSON.stringify(HEADER), JSON.stringify(KNOWN_EVENT), JSON.stringify(CUSTOM_EVENT), JSON.stringify(MARKED_EVENT), ''];
	const { text, changed } = markUnsupportedIgnorable(lines.join('\n'));
	const rewritten = text.split('\n');
	assert.deepEqual(changed, [{ type: 'web/clinepass-search-request', seq: 1 }]);
	assert.equal(rewritten[0], lines[0]);
	assert.equal(rewritten[1], lines[1]);
	assert.deepEqual(JSON.parse(rewritten[2]), { ...CUSTOM_EVENT, ignorable: true });
	assert.equal(rewritten[3], lines[3]);
	assert.equal(rewritten[4], '');
});

test('every repaired record satisfies the harness envelope contract', () => {
	const lines = [JSON.stringify(KNOWN_EVENT), JSON.stringify(CUSTOM_EVENT), ''];
	const { text } = markUnsupportedIgnorable(lines.join('\n'));
	for (const line of text.split('\n')) {
		if (line.trim().length === 0) continue;
		const event = JSON.parse(line);
		assert.doesNotThrow(() => adoptSessionEvent(event));
		assert.ok(KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.ignorable === true);
	}
});

test('scanSessionFile reports the offending event and its session id', () => {
	const dir = temporaryDir();
	const file = writeLog(dir, [HEADER, KNOWN_EVENT, CUSTOM_EVENT]);
	const report = scanSessionFile(file);
	assert.equal(report.sessionId, 'session-test');
	assert.equal(report.format, 'zstd');
	assert.deepEqual(report.unsupported, [{ lineIndex: 2, type: 'web/clinepass-search-request', seq: 1 }]);
});

test('repair is a dry run unless apply is set', () => {
	const dir = temporaryDir();
	const file = writeLog(dir, [HEADER, CUSTOM_EVENT]);
	const before = fs.readFileSync(file);
	const report = repairSessionFile(file, { activeWindowMs: 0 });
	assert.equal(report.applied, false);
	assert.equal(report.unsupported.length, 1);
	assert.deepEqual(fs.readFileSync(file), before);
});

test('repair preserves framing, keeps other lines byte-identical, and backs up', () => {
	const dir = temporaryDir();
	const file = writeLog(dir, [HEADER, KNOWN_EVENT, CUSTOM_EVENT, MARKED_EVENT]);
	const decodedBefore = decodeSessionFile(file);
	assert.equal(decodedBefore.frames.length, 4);
	const report = repairSessionFile(file, { apply: true, activeWindowMs: 0, backup: true });
	assert.equal(report.applied, true);
	assert.notEqual(report.backup, undefined);
	assert.equal(fs.existsSync(report.backup), true);
	const decodedAfter = decodeSessionFile(file);
	assert.equal(decodedAfter.frames.length, 4);
	const linesBefore = decodedBefore.text.split('\n');
	const linesAfter = decodedAfter.text.split('\n');
	assert.equal(linesAfter.length, linesBefore.length);
	assert.equal(linesAfter[0], linesBefore[0]);
	assert.equal(linesAfter[1], linesBefore[1]);
	assert.deepEqual(JSON.parse(linesAfter[2]), { ...CUSTOM_EVENT, ignorable: true });
	assert.equal(linesAfter[3], linesBefore[3]);
	assert.equal(linesAfter[4], '');
	assert.deepEqual(findUnsupportedEvents(decodedAfter.text), []);
	// The backup is the untouched original.
	assert.deepEqual(fs.readFileSync(report.backup), decodedBefore.buffer);
});

test('repair refuses a session that may still be open', () => {
	const dir = temporaryDir();
	const file = writeLog(dir, [HEADER, CUSTOM_EVENT]);
	const before = fs.readFileSync(file);
	const report = repairSessionFile(file, { apply: true, backup: true });
	assert.equal(report.applied, false);
	assert.match(report.skipped, /may still be open/u);
	assert.deepEqual(fs.readFileSync(file), before);
});

test('repair refuses a session holding a lock lease unless forced', () => {
	const dir = temporaryDir();
	const file = writeLog(dir, [HEADER, CUSTOM_EVENT]);
	fs.writeFileSync(path.join(dir, 'session.lock'), '');
	const before = fs.readFileSync(file);
	const report = repairSessionFile(file, { apply: true, activeWindowMs: 0, backup: true });
	assert.equal(report.applied, false);
	assert.match(report.skipped, /session\.lock/u);
	assert.deepEqual(fs.readFileSync(file), before);
});

test('listSessionFiles sees only the current generation', () => {
	const home = temporaryDir();
	const sessionDir = path.join(home, 'sessions', '--project--', 'session-abc');
	fs.mkdirSync(sessionDir, { recursive: true });
	writeLog(sessionDir, [HEADER, CUSTOM_EVENT]);
	writeLog(sessionDir, [HEADER], 'session.jsonl.zstd');
	writeLog(sessionDir, [HEADER], SESSION_FILE + '.bak-2026-01-01');
	const files = listSessionFiles(home);
	assert.deepEqual(files, [path.join(sessionDir, SESSION_FILE)]);
});
