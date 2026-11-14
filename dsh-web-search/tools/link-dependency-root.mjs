#!/usr/bin/env node
/**
 * Point this package's `node_modules` at the module closure of the *installed*
 * DSH payload, discovered at run time — never a hardcoded path.
 *
 * Why this exists: dsh links an out-of-tree bundle into a profile with a
 * junction, so the module runs from its real location here and its bare
 * imports (`@deepseek-ai/dsh-web`, `@deepseek-ai/schemastery`, ...) resolve by
 * walking up from THIS directory. Without a `node_modules` here the loader dies
 * with `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'`
 * and the plugin cannot be enabled.
 *
 * `link-harness-runtime.mjs` solves the same problem by extracting an `app.asar`
 * into real directories. This tool is the lighter sibling for installs that are
 * already unpacked (a patched app.asar, a `resources/app/` layout): it only
 * creates one junction, so a DSH upgrade can never leave stale copies behind —
 * re-run it and the link follows the new install.
 *
 * Usage:
 *   node tools/link-dependency-root.mjs [--dry-run] [--json]
 *                                       [--install <dir>] [--modules <dir>]
 *                                       [--force]
 *
 * Discovery order, first hit wins:
 *   1. --modules <dir>            explicit closure directory
 *   2. $DSH_HARNESS_MODULES       same, from the environment
 *   3. --install <dir>            explicit install root; closures are probed under it
 *   4. $DSH_HARNESS_INSTALL       same, from the environment
 *   5. well-known install roots   (LOCALAPPDATA, Program Files, /Applications, ...)
 *
 * A candidate only counts if every package this plugin actually imports is
 * present as a *readable directory with a package.json* — a dangling symlink
 * tree must not be accepted, which is exactly how the shared
 * `<DSH_HOME>/profiles/node_modules` closure decays after a DSH reinstall.
 */
import { createRequire } from 'node:module';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readlinkSync, readdirSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const linkPath = join(packageDir, 'node_modules');

/** Bare specifiers imported by src/*.js; a closure missing any of them is unusable. */
const REQUIRED = [
	'@deepseek-ai/schemastery',
	'@deepseek-ai/dsh-web',
	'@deepseek-ai/dsh-credentials',
	'@deepseek-ai/dsh-launch-environment',
];

/** Closure layouts, relative to an install root, newest first. */
const CLOSURE_LAYOUTS = [
	join('resources', 'app', 'dsh', 'node_modules'),
	join('resources', 'app', 'node_modules'),
	join('resources', 'app.asar.unpacked', 'dsh', 'node_modules'),
	join('resources', 'app.asar.unpacked', 'node_modules'),
	join('resources', 'dsh', 'node_modules'),
];

function parseArgs(argv) {
	const options = { dryRun: false, json: false, install: undefined, modules: undefined, force: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--dry-run') options.dryRun = true;
		else if (arg === '--json') options.json = true;
		else if (arg === '--install' || arg === '-i') options.install = argv[++i];
		else if (arg === '--modules' || arg === '-m') options.modules = argv[++i];
		else if (arg === '--force' || arg === '-f') options.force = true;
		else if (arg === '--help' || arg === '-h') options.help = true;
		else throw new Error('unknown argument: ' + arg);
	}
	return options;
}

function usage() {
	console.log([
		'Point this package\'s node_modules at the installed DSH module closure.',
		'',
		'  node tools/link-dependency-root.mjs [--dry-run] [--json] [--force]',
		'                                      [--install <dir>] [--modules <dir>]',
		'',
		'  --modules <dir>    use this closure directory as-is',
		'  --install <dir>    DSH install root (the folder holding resources/)',
		'  --dry-run          report what would happen, write nothing',
		'  --force            replace a real (non-link) node_modules directory',
		'  --json             machine-readable summary',
	].join('\n'));
}

/** A package counts only when its package.json is a readable file. */
function packageUsable(dir, specifier) {
	try {
		return statSync(join(dir, specifier, 'package.json')).isFile();
	} catch {
		return false;
	}
}

/** @returns a short reason string when the directory is not a usable closure. */
function closureProblem(dir) {
	if (!existsSync(dir)) return 'does not exist';
	if (!statSync(dir).isDirectory()) return 'not a directory';
	const missing = REQUIRED.filter((specifier) => !packageUsable(dir, specifier));
	return missing.length === 0 ? undefined : 'missing ' + missing.join(', ');
}

function defaultRoots() {
	const roots = [
		process.env.DSH_HARNESS_ROOTS,
		process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
		process.env.LOCALAPPDATA,
		process.env.PROGRAMDATA,
		process.env.PROGRAMFILES,
		process.env['PROGRAMFILES(X86)'],
		process.env.ProgramW6432,
		join(homedir(), 'Applications'),
		'/Applications',
		'/opt',
		'/usr/local',
		'D:\\apps',
		'C:\\apps',
	];
	return roots.filter(Boolean).flatMap((root) => String(root).split(';')).filter(Boolean);
}

/** Does `dir` look like a DSH install root (it has a `resources` folder)? */
function looksLikeInstall(dir) {
	try {
		return statSync(join(dir, 'resources')).isDirectory();
	} catch {
		return false;
	}
}

/** Bounded depth-first search for install roots under `root`. */
function scanForInstalls(root, depth, found = []) {
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
		const dir = join(root, entry.name);
		if (looksLikeInstall(dir)) found.push(dir);
		else if (depth > 0) scanForInstalls(dir, depth - 1, found);
	}
	return found;
}

/**
 * Whether an asar's file table carries the DSH Desktop host package directory, which keeps other
 * Electron apps on the machine from qualifying. The table nests directories, so the marker is the
 * quoted key, not a full path.
 */
function isDshPayload(asarPath) {
	let fd;
	try {
		fd = openSync(asarPath, 'r');
		const head = Buffer.alloc(16);
		if (readSync(fd, head, 0, 16, 0) < 16 || head.readUInt32LE(0) !== 4) return false;
		const jsonLength = head.readUInt32LE(12);
		if (jsonLength <= 0 || jsonLength > 64 * 1024 * 1024) return false;
		const jsonBuf = Buffer.alloc(jsonLength);
		let read = 0;
		// A single readSync may return short; the file table is several megabytes.
		while (read < jsonLength) {
			const chunk = readSync(fd, jsonBuf, read, jsonLength - read, 16 + read);
			if (chunk <= 0) break;
			read += chunk;
		}
		return read === jsonLength && jsonBuf.toString('utf8').includes('"dsh-desktop-host"');
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** The asar an install may keep its closure in, whether or not it is really a DSH payload. */
function asarCandidateOf(install) {
	const candidate = join(install, 'resources', 'app.asar');
	return existsSync(candidate) ? candidate : undefined;
}

/**
 * Resolve the closure directory.
 * @returns {{dir: string, install?: string, source: string}
 *   | {error: string, tried: string[], packed: string[]}}
 */
function locateClosure(options) {
	const tried = [];
	const asarCandidates = [];
	const explicit = options.modules ?? process.env.DSH_HARNESS_MODULES;
	if (explicit !== undefined && String(explicit).length > 0) {
		const dir = resolve(String(explicit));
		const problem = closureProblem(dir);
		if (problem === undefined) return { dir, source: 'explicit-modules' };
		tried.push(dir + ' (' + problem + ')');
	}

	const installs = [];
	if (options.install !== undefined || process.env.DSH_HARNESS_INSTALL !== undefined) {
		installs.push(resolve(String(options.install ?? process.env.DSH_HARNESS_INSTALL)));
	} else {
		for (const root of defaultRoots()) installs.push(...scanForInstalls(root, 2));
	}

	for (const install of installs) {
		const asarCandidate = asarCandidateOf(install);
		if (asarCandidate !== undefined) asarCandidates.push(asarCandidate);
		for (const layout of CLOSURE_LAYOUTS) {
			const dir = join(install, layout);
			const problem = closureProblem(dir);
			if (problem === undefined) return { dir, install, source: 'discovered' };
			if (existsSync(dir)) tried.push(dir + ' (' + problem + ')');
		}
	}
	// Only pay for header inspection when nothing usable was found, and only
	// report payloads that really are DSH: other Electron apps are everywhere.
	return { error: 'no usable DSH module closure found', tried, packed: asarCandidates.filter(isDshPayload) };
}

/** Remove an existing link at `path`. A real directory is left alone. */
function clearLink(path, force) {
	let stat;
	try {
		stat = lstatSync(path);
	} catch {
		return 'absent';
	}
	if (stat.isSymbolicLink()) {
		unlinkSync(path);
		return 'relinked';
	}
	if (!stat.isDirectory()) {
		unlinkSync(path);
		return 'relinked';
	}
	if (force === true && readdirSync(path).length === 0) {
		rmdirSync(path);
		return 'relinked';
	}
	return 'blocked';
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) return usage();

	const found = locateClosure(options);
	if (found.error !== undefined) {
		console.error(found.error + '.');
		console.error('Pass --modules <dir> pointing at a node_modules that contains ' + REQUIRED.join(', ') + ',');
		console.error('or --install <DSH install dir> (the folder that holds resources/).');
		if (found.tried.length > 0) {
			console.error('\nCandidates rejected:');
			for (const line of found.tried) console.error('  ' + line);
		}
		for (const payload of found.packed) {
			console.error('\nThis install keeps its closure packed inside ' + payload + '.');
			console.error('A junction cannot point into an archive, so extract the closure instead:');
			console.error('  node tools/link-harness-runtime.mjs --asar "' + payload + '"');
		}
		process.exitCode = 1;
		return;
	}

	// What is there now?
	let current;
	try {
		current = lstatSync(linkPath).isSymbolicLink() ? readlinkSync(linkPath) : '<real directory>';
	} catch {
		current = undefined;
	}

	const outcome = current === found.dir ? 'already-linked' : 'link';
	if (outcome === 'link' && options.dryRun !== true) {
		const cleared = clearLink(linkPath, options.force);
		if (cleared === 'blocked') {
			console.error(linkPath + ' is a real directory with contents; leaving it alone.');
			console.error('Remove it yourself (or re-run with --force if it is empty), then try again.');
			process.exitCode = 1;
			return;
		}
		mkdirSync(packageDir, { recursive: true });
		symlinkSync(found.dir, linkPath, 'junction');
	}

	// Prove it works the way the loader will, not just that a link exists.
	const problems = [];
	if (options.dryRun !== true) {
		const require = createRequire(join(packageDir, 'noop.js'));
		for (const specifier of REQUIRED) {
			try {
				require.resolve(specifier);
			} catch (error) {
				problems.push(specifier + ': ' + (error instanceof Error ? error.message : String(error)));
			}
		}
	}

	const summary = {
		action: options.dryRun === true ? (outcome === 'link' ? 'would-link' : outcome) : outcome,
		link: linkPath,
		target: found.dir,
		install: found.install,
		source: found.source,
		previous: current,
		verified: problems.length === 0 && options.dryRun !== true,
		problems,
	};
	if (options.json === true) {
		console.log(JSON.stringify(summary, undefined, 2));
	} else {
		console.log('dsh closure  : ' + found.dir + (found.install === undefined ? '' : '  (install: ' + found.install + ')'));
		console.log('this package : ' + linkPath);
		console.log('action       : ' + summary.action + (current === undefined ? '' : '  (was: ' + current + ')'));
		console.log('resolution   : ' + (options.dryRun === true ? 'skipped under --dry-run' : problems.length === 0 ? 'ok — ' + REQUIRED.length + ' bare imports resolve' : 'FAILED'));
		for (const problem of problems) console.log('  ! ' + problem);
	}
	if (problems.length > 0) process.exitCode = 1;
}

try {
	await main();
} catch (error) {
	console.error('link-dependency-root failed: ' + (error instanceof Error ? error.message : String(error)));
	process.exitCode = 1;
}
