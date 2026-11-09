/**
 * Repair DSH session logs that a plugin poisoned with a custom session event.
 *
 * Background: DSH persists sessions fail-closed. Its read path accepts an event
 * type outside KNOWN_SESSION_EVENT_TYPES only when the event envelope carries
 * `ignorable: true`; anything else refuses the WHOLE log, so the session can no
 * longer be listed, resumed, or queried. An out-of-repo plugin cannot write that
 * marker (Session.append() takes only surface metadata as its third argument),
 * so any plugin that appends a custom type leaves permanently unopenable
 * sessions behind.
 *
 * This tool finds those events and, on request, marks exactly those envelopes
 * `ignorable: true` -- the marker the harness writer would have set for a
 * purely informational record. Nothing else in the log is touched: frame
 * boundaries are preserved, untouched lines are copied byte-for-byte, and the
 * original file is backed up first.
 *
 * Usage:
 *   node tools/repair-session-events.mjs scan   [--home <DSH_HOME>] [--session <id>]
 *   node tools/repair-session-events.mjs repair [--home <DSH_HOME>] [--session <id>] [--apply] [--no-backup] [--force]
 *
 * `scan` only reports. `repair` is a dry run unless --apply is given.
 * `--force` overrides the guard that skips a session with a session.lock lease
 * or one written in the last five minutes (both mean it may still be open).
 *
 * @module dsh-web-search-clinepass/tools/repair-session-events
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

/** Default DSH home: $DSH_HOME, else ~/.dsh. */
export function defaultHome() {
	const fromEnv = process.env.DSH_HOME;
	if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
	return path.join(os.homedir(), '.dsh');
}

/**
 * Load the installed harness's session vocabulary.
 *
 * A checkout used for development has a `node_modules` junction, but a user who
 * merely installed the plugin has only its profile, so fall back to the profile
 * module closures and to the CLI's own install tree. The vocabulary must come
 * from the harness that reads the log, never from a copy baked in here.
 * @returns the loaded `@deepseek-ai/dsh-session` module.
 */
async function loadSessionModule() {
	const candidates = ['@deepseek-ai/dsh-session'];
	const home = defaultHome();
	const profiles = path.join(home, 'profiles');
	candidates.push(path.join(profiles, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js'));
	try {
		for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === 'node_modules') continue;
			candidates.push(path.join(profiles, entry.name, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js'));
		}
	} catch {
		/* no profiles directory: the other candidates still apply */
	}
	const nodeDir = path.dirname(process.execPath);
	candidates.push(path.join(nodeDir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js'));
	candidates.push(path.join(nodeDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js'));
	for (const candidate of candidates) {
		try {
			if (candidate.startsWith('@')) return await import(candidate);
			if (fs.existsSync(candidate)) return await import(pathToFileURL(candidate).href);
		} catch {
			/* try the next candidate */
		}
	}
	throw new Error('cannot resolve @deepseek-ai/dsh-session: install this plugin into a DSH profile, or run the tool from a checkout with the documented node_modules junction');
}

const { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION } = await loadSessionModule();

const ZSTD_MAGIC = 4247762216;
/** Zstandard frames written by the harness are checksummed; repaired frames must be too. */
const ZSTD_CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const ZSTD_SUFFIX = '.jsonl.zstd';
const LOCK_FILENAME = 'session.lock';
/**
 * A session artifact written within this window is treated as possibly open.
 * The harness appends to an open session continuously and may replace the file
 * during a rewrite, so an active session must be closed before it is repaired.
 */
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Locate every complete Zstandard frame in one session artifact without
 * decompressing it. Mirrors the harness decoder's framing contract so repaired
 * logs keep the exact append-only batch structure the reader expects.
 * @param buffer - the complete bytes currently present in the artifact.
 * @returns the complete frame ranges, plus the start of a torn final frame.
 */
export function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return { frames, tornStart: start };
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid Zstandard frame magic at byte ' + offset);
		offset += 4;
		if (offset === buffer.length) return { frames, tornStart: start };
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error('reserved Zstandard frame-header bit at byte ' + (offset - 1));
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) return { frames, tornStart: start };
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error('reserved Zstandard block type at byte ' + (offset - 3));
			offset += blockType === 1 ? 1 : blockSize;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return { frames, tornStart: start };
			offset += 4;
		}
		frames.push({ start, end: offset });
	}
	return { frames };
}

/**
 * Decode one session artifact into its frames and plaintext.
 * @param file - path to `session.v<version>.jsonl.zstd` (or a plain `.jsonl`).
 * @returns the physical format, frame ranges, per-frame plaintext, and the concatenation.
 */
export function decodeSessionFile(file) {
	const buffer = fs.readFileSync(file);
	if (!file.endsWith(ZSTD_SUFFIX)) {
		const text = buffer.toString('utf8');
		return { format: 'plain', buffer, frames: [], frameTexts: [text], text };
	}
	const { frames, tornStart } = scanZstdFrames(buffer);
	if (tornStart !== undefined) throw new Error('refusing to repair a torn log: incomplete final frame at byte ' + tornStart);
	const frameTexts = frames.map((frame) => zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'));
	return { format: 'zstd', buffer, frames, frameTexts, text: frameTexts.join('') };
}

/** Parse JSONL text into its lines and parsed records, refusing unparsable input. */
function parseRecords(text) {
	const lines = text.split('\n');
	const records = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim().length === 0) continue;
		let value;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error('line ' + (index + 1) + ' is not JSON; refusing to rewrite an unparsable log');
		}
		records.push({ lineIndex: index, line, value });
	}
	return { lines, records };
}

/**
 * Whether one decoded record is an event the harness read path would refuse.
 * Only a session EVENT is considered: the `session` header frame carries no
 * `seq`, and legacy generations (`session.jsonl.zstd`) are never scanned.
 */
function isUnsupported(value, known) {
	return value !== null && typeof value === 'object' && typeof value.type === 'string'
		&& typeof value.seq === 'number' && !known.has(value.type) && value.ignorable !== true;
}

/**
 * Find the events the harness read path would refuse.
 * @param text - decoded JSONL plaintext.
 * @param known - the known event-type vocabulary (defaults to the installed harness's).
 * @returns one entry per unsupported event, in log order.
 */
export function findUnsupportedEvents(text, known = KNOWN_SESSION_EVENT_TYPES) {
	const found = [];
	for (const record of parseRecords(text).records) {
		if (!isUnsupported(record.value, known)) continue;
		found.push({ lineIndex: record.lineIndex, type: record.value.type, seq: record.value.seq });
	}
	return found;
}

/**
 * Mark exactly the unsupported event envelopes `ignorable: true`, keeping every
 * other line byte-for-byte. Used for whole-plaintext (uncompressed) logs.
 * @param text - decoded JSONL plaintext.
 * @param known - the known event-type vocabulary.
 * @returns the rewritten plaintext plus what changed.
 */
export function markUnsupportedIgnorable(text, known = KNOWN_SESSION_EVENT_TYPES) {
	const { lines, records } = parseRecords(text);
	const changed = [];
	for (const record of records) {
		if (!isUnsupported(record.value, known)) continue;
		lines[record.lineIndex] = JSON.stringify({ ...record.value, ignorable: true });
		changed.push({ type: record.value.type, seq: record.value.seq });
	}
	return { text: lines.join('\n'), changed };
}

/**
 * Encode rewritten plaintext back into the original framing, checksummed.
 * @param original - the decoded artifact from {@link decodeSessionFile}.
 * @param frameTexts - the replacement text for each frame, same length and order.
 * @returns the bytes to write.
 */
export function encodeSessionFile(original, frameTexts) {
	if (original.format === 'plain') return Buffer.from(frameTexts[0] ?? '', 'utf8');
	if (frameTexts.length !== original.frames.length) throw new Error('repair would change the frame count; refusing to write');
	const encoded = frameTexts.map((text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), ZSTD_CHECKSUM));
	return Buffer.concat(encoded);
}

/**
 * Scan one session artifact. Never writes.
 * @param file - path to the session artifact.
 * @returns the session id, physical format, and every unsupported event.
 */
export function scanSessionFile(file) {
	const decoded = decodeSessionFile(file);
	const header = parseRecords(decoded.text).records.find((record) => record.value?.type === 'session')?.value;
	return {
		file,
		sessionId: typeof header?.id === 'string' ? header.id : undefined,
		format: decoded.format,
		unsupported: findUnsupportedEvents(decoded.text),
	};
}

/**
 * Mark every unsupported event in one session artifact ignorable.
 * @param file - path to the session artifact.
 * @param options - apply, backup, and force switches.
 * @returns the report: what was found, what changed, and whether bytes were written.
 */
export function repairSessionFile(file, options = {}) {
	const apply = options.apply === true;
	const force = options.force === true;
	const withBackup = options.backup !== false;
	const activeWindowMs = Number.isFinite(options.activeWindowMs) ? options.activeWindowMs : ACTIVE_WINDOW_MS;
	const report = scanSessionFile(file);
	report.applied = false;
	if (report.unsupported.length === 0 || !apply) return report;
	if (!force) {
		const lock = path.join(path.dirname(file), LOCK_FILENAME);
		if (fs.existsSync(lock)) {
			report.skipped = 'session.lock is present (the session is open); close it and rerun, or pass --force to repair anyway';
			return report;
		}
		const idleMs = Date.now() - fs.statSync(file).mtimeMs;
		// A zero window means "no window" and must disable the check outright: a
		// file written a moment ago can carry an mtime a fraction of a millisecond
		// ahead of Date.now() (filesystem timestamp granularity), and that negative
		// idle must not refuse an explicitly windowless repair. A positive window
		// still refuses on negative idle, which is the just-written case it guards.
		if (activeWindowMs > 0 && idleMs < activeWindowMs) {
			report.skipped = 'written ' + String(Math.round(idleMs / 1000)) + 's ago (the session may still be open); close it and rerun, or pass --force to repair anyway';
			return report;
		}
	}
	const decoded = decodeSessionFile(file);
	const changed = [];
	const frameTexts = decoded.frameTexts.map((frameText) => {
		const marked = markUnsupportedIgnorable(frameText);
		changed.push(...marked.changed);
		return marked.text;
	});
	const text = frameTexts.join('');
	const encoded = encodeSessionFile(decoded, frameTexts);
	if (withBackup) {
		const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
		report.backup = file + '.bak-' + stamp;
		fs.copyFileSync(file, report.backup, fs.constants.COPYFILE_EXCL);
	}
	const temporary = file + '.repair-' + String(process.pid) + '.tmp';
	try {
		fs.writeFileSync(temporary, encoded);
		fs.renameSync(temporary, file);
	} catch (error) {
		try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
		throw error;
	}
	// Read the written artifact back through the same decoder and re-check the gate.
	const verify = decodeSessionFile(file);
	const remaining = findUnsupportedEvents(verify.text);
	if (verify.text !== text || remaining.length > 0) {
		if (report.backup !== undefined) fs.copyFileSync(report.backup, file);
		throw new Error('post-write verification failed; the original file was restored' + (remaining.length > 0 ? ': ' + String(remaining.length) + ' unsupported event(s) remain' : ''));
	}
	report.applied = true;
	report.changed = changed;
	return report;
}

/**
 * Every CURRENT-generation session artifact under one DSH home.
 *
 * Historical generations (`session.jsonl.zstd`, `session.v2.jsonl.zstd`, ...)
 * are migrated by the harness before the vocabulary gate runs, so this tool
 * deliberately leaves them alone.
 * @param home - the DSH home directory holding `sessions/`.
 * @param sessionFilter - optional session directory name (with or without the `session-` prefix).
 * @returns absolute artifact paths.
 */
export function listSessionFiles(home, sessionFilter) {
	const root = path.join(home, 'sessions');
	if (!fs.existsSync(root)) return [];
	const current = 'session.v' + String(SESSION_FORMAT_VERSION);
	const files = [];
	for (const project of fs.readdirSync(root, { withFileTypes: true })) {
		if (!project.isDirectory()) continue;
		const projectDir = path.join(root, project.name);
		for (const session of fs.readdirSync(projectDir, { withFileTypes: true })) {
			if (!session.isDirectory()) continue;
			if (sessionFilter !== undefined && session.name !== sessionFilter && session.name !== 'session-' + sessionFilter) continue;
			const sessionDir = path.join(projectDir, session.name);
			for (const entry of fs.readdirSync(sessionDir)) {
				if (entry !== current + ZSTD_SUFFIX && entry !== current + '.jsonl') continue;
				files.push(path.join(sessionDir, entry));
			}
		}
	}
	return files;
}

function parseArgs(argv) {
	const options = { command: 'scan', apply: false, backup: true, force: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === 'scan' || arg === 'repair') options.command = arg;
		else if (arg === '--apply') options.apply = true;
		else if (arg === '--no-backup') options.backup = false;
		else if (arg === '--force') options.force = true;
		else if (arg === '--home') options.home = argv[++index];
		else if (arg === '--session') options.session = argv[++index];
		else throw new Error('unknown argument: ' + arg);
	}
	return options;
}

function main(argv) {
	const options = parseArgs(argv);
	const home = options.home ?? defaultHome();
	const apply = options.command === 'repair' && options.apply;
	let affected = 0;
	let repaired = 0;
	let failed = 0;
	for (const file of listSessionFiles(home, options.session)) {
		let report;
		try {
			report = options.command === 'scan' ? scanSessionFile(file) : repairSessionFile(file, { apply, backup: options.backup, force: options.force });
		} catch (error) {
			failed += 1;
			console.log(path.basename(path.dirname(file)));
			console.log('  file: ' + file);
			console.log('  failed: ' + String(error?.message ?? error));
			continue;
		}
		if (report.unsupported.length === 0) continue;
		affected += 1;
		console.log(report.sessionId ?? path.basename(path.dirname(file)));
		console.log('  file: ' + file);
		for (const event of report.unsupported) console.log('  unsupported: ' + event.type + ' (seq ' + String(event.seq) + ')');
		if (report.skipped !== undefined) console.log('  skipped: ' + report.skipped);
		else if (report.applied) {
			repaired += 1;
			console.log('  repaired: marked ' + String(report.changed.length) + ' event(s) ignorable' + (report.backup === undefined ? '' : '; backup ' + report.backup));
		} else if (options.command === 'repair') console.log('  dry run: rerun with --apply to rewrite this file');
	}
	if (affected === 0) console.log('no session log under ' + home + ' needs repair');
	else if (options.command === 'scan') console.log(String(affected) + ' session log(s) would refuse to load');
	else console.log(String(affected) + ' session log(s) need repair, ' + String(repaired) + ' rewritten');
	if (failed > 0) console.log(String(failed) + ' session log(s) could not be read; rerun when they are idle');
	return failed > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		console.error(String(error?.message ?? error));
		process.exitCode = 1;
	}
}
