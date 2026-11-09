#!/usr/bin/env node
/**
 * Restore this package's local DSH module closure from an installed DSH payload.
 *
 * The plugin's bare imports (`@deepseek-ai/dsh-web`, `@deepseek-ai/schemastery`,
 * `@deepseek-ai/dsh-session`, ...) are supplied at runtime by whichever harness
 * loads it, so they are deliberately absent from `dependencies`. Unit tests run
 * under plain Node, though, and Node resolves from this directory - so without a
 * closure here every test that touches those imports dies with
 * `ERR_MODULE_NOT_FOUND`.
 *
 * The packages are not on npm at the harness's version (the registry copy of
 * `@deepseek-ai/dsh-web` is a stale `0.0.1-rc.1`), so the only faithful source is
 * the installed harness itself. This tool reads the Electron `app.asar` of a DSH
 * desktop install, walks the *actual* import graph from a seed set, and writes
 * exactly those packages into `node_modules/`.
 *
 * It never follows the existing `node_modules` if that is a junction or symlink:
 * earlier setups pointed it at a shared harness tree, and writing through a
 * dangling one would land in the DSH profile directory instead. A link is
 * removed and replaced; a real directory is reused in place.
 *
 * Usage:
 *   node tools/link-harness-runtime.mjs [--asar <path>] [--dry-run] [--clean]
 *                                       [--with-react] [--seeds a,b,c] [--json]
 */
import { builtinModules } from 'node:module';
import {
	closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync,
	readlinkSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_MANIFEST = '.dsh-harness-runtime.json';

/**
 * Packages the test suite and the live probe import directly. The closure walk
 * pulls in everything these need transitively.
 */
const DEFAULT_SEEDS = [
	'@deepseek-ai/schemastery',
	'@deepseek-ai/dsh-web',
	'@deepseek-ai/dsh-credentials',
	'@deepseek-ai/dsh-launch-environment',
	'@deepseek-ai/dsh-session',
	'@deepseek-ai/cordis',
	'js-yaml',
];

/** React is not shipped in the desktop payload (the web UI arrives prebuilt). */
const REACT_RANGE = { react: '18.3.1', 'react-dom': '18.3.1' };

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, 'node:' + name]));
const TEXT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.json'];

function parseArgs(argv) {
	const options = { asar: undefined, dryRun: false, clean: false, withReact: false, seeds: DEFAULT_SEEDS, json: false, maxFileMb: 64 };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--asar' || arg === '-a') options.asar = argv[++i];
		else if (arg === '--dry-run') options.dryRun = true;
		else if (arg === '--clean') options.clean = true;
		else if (arg === '--with-react') options.withReact = true;
		else if (arg === '--json') options.json = true;
		else if (arg === '--seeds') options.seeds = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
		else if (arg === '--max-file-mb') options.maxFileMb = Number(argv[++i]);
		else if (arg === '--help' || arg === '-h') options.help = true;
		else throw new Error('unknown argument: ' + arg);
	}
	return options;
}

function usage() {
	console.log([
		'Restore node_modules/ from an installed DSH payload.',
		'',
		'  node tools/link-harness-runtime.mjs [options]',
		'',
		'  --asar <path>      app.asar of a DSH desktop install',
		'  --dry-run          report the closure without writing',
		'  --clean            delete node_modules/ first (only if it is a real directory)',
		'  --with-react       npm-install react + react-dom so the card render tests run',
		'  --seeds a,b,c      override the seed package list',
		'  --max-file-mb <n>  skip single files above this size (default 64)',
		'  --json             machine-readable summary',
	].join('\n'));
}

/**
 * Find the payload of an installed DSH desktop app.
 *
 * An explicit `--asar` or `DSH_HARNESS_ASAR` always wins; otherwise a handful of
 * install roots are scanned, which covers the default Electron locations.
 * @param explicit - path from the command line, if any.
 * @returns the first existing `app.asar`, or undefined.
 */
function locateAsar(explicit) {
	if (typeof explicit === 'string' && explicit.length > 0) {
		const path = resolve(explicit);
		if (isAsar(path)) return path;
		throw new Error('not a readable app.asar: ' + path);
	}
	const fromEnv = process.env.DSH_HARNESS_ASAR;
	if (typeof fromEnv === 'string' && fromEnv.length > 0 && isAsar(fromEnv)) return fromEnv;
	const roots = [
		process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
		process.env.PROGRAMFILES,
		process.env['PROGRAMFILES(X86)'],
		process.env.ProgramW6432,
		'D:\\apps',
		'C:\\apps',
	].filter(Boolean);
	for (const root of roots) {
		const found = scanForAsar(root, 2);
		if (found !== undefined) return found;
	}
	return undefined;
}

function isAsar(path) {
	let fd;
	try {
		if (!statSync(path).isFile()) return false;
		fd = openSync(path, 'r');
		const head = Buffer.alloc(16);
		if (readSync(fd, head, 0, 16, 0) < 16) return false;
		return head.readUInt32LE(0) === 4;
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Bounded depth-first search for `<dir>/resources/app.asar`. */
function scanForAsar(dir, depth) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const candidate = join(dir, entry.name, 'resources', 'app.asar');
		if (isAsar(candidate)) return candidate;
	}
	if (depth <= 0) return undefined;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const found = scanForAsar(join(dir, entry.name), depth - 1);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** Open an asar and decode its header pickle. */
function openAsar(asarPath) {
	const fd = openSync(asarPath, 'r');
	const head = Buffer.alloc(16);
	readSync(fd, head, 0, 16, 0);
	const pickleSize = head.readUInt32LE(4);
	const jsonLength = head.readUInt32LE(8);
	if (jsonLength <= 0 || jsonLength > 64 * 1024 * 1024) throw new Error('implausible asar header length: ' + jsonLength);
	const jsonBuf = Buffer.alloc(jsonLength);
	readSync(fd, jsonBuf, 0, jsonLength, 16);
	// The header string is followed by alignment padding, so cut at the final
	// closing brace instead of trusting the declared length to be exact.
	const text = jsonBuf.toString('utf8');
	const end = text.lastIndexOf('}');
	const header = JSON.parse(end === -1 ? text : text.slice(0, end + 1));
	if (header === null || typeof header !== 'object' || typeof header.files !== 'object') throw new Error('asar header has no file table');
	return { fd, header, dataStart: 8 + pickleSize, asarPath };
}

/**
 * Index every package directory in the payload.
 *
 * A hoisted layout keeps most packages at `node_modules/<name>`, but nested
 * copies exist, so the shallowest directory carrying a `package.json` wins.
 * @param header - the decoded asar header.
 * @returns a map of package name to its node and depth.
 */
function indexPackages(header) {
	const index = new Map();
	const walk = (node, parts) => {
		if (node === null || typeof node !== 'object' || node.files === undefined) return;
		const names = Object.keys(node.files);
		if (parts.includes('node_modules') && names.includes('package.json')) {
			const at = parts.lastIndexOf('node_modules');
			const after = parts.slice(at + 1);
			if (after.length >= 1) {
				const name = after[0].startsWith('@') ? after[0] + '/' + after[1] : after[0];
				const previous = index.get(name);
				if (previous === undefined || parts.length < previous.depth) index.set(name, { name, node, parts: [...parts], depth: parts.length });
			}
		}
		for (const name of names) walk(node.files[name], [...parts, name]);
	};
	// `header.files` is the root's child map, not a directory node, so wrap it
	// once to give the walker the shape it expects.
	walk({ files: header.files }, []);
	return index;
}

/** Collect every file in a directory node, as `relative/path -> entry`. */
function filesOf(node, prefix = '') {
	const out = new Map();
	const walk = (current, path) => {
		for (const [name, child] of Object.entries(current.files)) {
			const next = path === '' ? name : path + '/' + name;
			if (child !== null && typeof child === 'object' && child.files !== undefined) walk(child, next);
			else out.set(next, child);
		}
	};
	walk(node, prefix);
	return out;
}

/** Read one file's bytes, honouring `unpacked` entries stored beside the asar. */
function readEntry(asar, asarPath, entry) {
	if (entry.unpacked === true) {
		// Unpacked files keep their full path under `<asar>.unpacked`.
		const hostPath = join(asar.asarPath + '.unpacked', ...asarPath.split('/'));
		return existsSync(hostPath) ? readFileSync(hostPath) : undefined;
	}
	// This asar flavour serializes `offset` as a decimal string.
	const size = Number(entry.size);
	const start = asar.dataStart + Number(entry.offset);
	const buffer = Buffer.alloc(size);
	let read = 0;
	while (read < size) read += readSync(asar.fd, buffer, read, size - read, start + read);
	return buffer;
}

/** A plausible npm package name, which rejects the JSON keys the regexes trip over. */
const PACKAGE_NAME_PATTERN = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/u;

/** The package a bare specifier belongs to, or undefined when it is not one. */
function packageOfSpecifier(specifier) {
	if (typeof specifier !== 'string' || specifier.length === 0) return undefined;
	if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return undefined;
	if (specifier.startsWith('node:') || specifier.startsWith('data:') || specifier.startsWith('file:')) return undefined;
	if (BUILTINS.has(specifier)) return undefined;
	if (specifier.includes('://')) return undefined;
	const parts = specifier.split('/');
	const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
	if (!PACKAGE_NAME_PATTERN.test(name)) return undefined;
	return name.length > 0 ? name : undefined;
}

const SPECIFIER_PATTERNS = [
	/(?<!["'\w$])from\s*["']([^"']+)["']/gu,
	/(?<!["'\w$.])import\s*\(\s*["']([^"']+)["']\s*\)/gu,
	/(?<!["'\w$.])require\s*\(\s*["']([^"']+)["']\s*\)/gu,
	/(?<!["'\w$.])import\s*["']([^"']+)["']/gu,
];

/** Every bare specifier a chunk of JavaScript mentions. */
function specifiersOf(text) {
	const names = new Set();
	for (const pattern of SPECIFIER_PATTERNS) {
		pattern.lastIndex = 0;
		let match;
		while ((match = pattern.exec(text)) !== null) {
			const name = packageOfSpecifier(match[1]);
			if (name !== undefined) names.add(name);
		}
	}
	return names;
}

/** Declared runtime dependencies of a package, which the payload may or may not carry. */
function declaredDependencies(asar, node) {
	const files = filesOf(node);
	const entry = files.get('package.json');
	if (entry === undefined) return [];
	try {
		const manifest = JSON.parse(readEntry(asar, '', entry).toString('utf8'));
		return Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).filter((n) => packageOfSpecifier(n) === n);
	} catch {
		return [];
	}
}

/**
 * Walk the import graph from the seed set.
 * @param asar - the open payload.
 * @param index - the package index.
 * @param seeds - packages to start from.
 * @returns the resolved packages plus the specifiers nothing in the payload serves.
 */
function resolveClosure(asar, index, seeds) {
	const chosen = new Map();
	const missing = new Set();
	const queue = [...seeds];
	while (queue.length > 0) {
		const name = queue.shift();
		if (chosen.has(name)) continue;
		const found = index.get(name);
		if (found === undefined) {
			missing.add(name);
			continue;
		}
		chosen.set(name, found);
		const base = found.parts.join('/');
		const referenced = new Set(declaredDependencies(asar, found.node));
		for (const [path, entry] of filesOf(found.node)) {
			if (!TEXT_EXTENSIONS.some((extension) => path.endsWith(extension))) continue;
			if (entry.size > 8 * 1024 * 1024) continue;
			let text;
			try {
				text = readEntry(asar, base + '/' + path, entry).toString('utf8');
			} catch {
				continue;
			}
			for (const specifier of specifiersOf(text)) referenced.add(specifier);
		}
		for (const dependency of referenced) {
			if (!chosen.has(dependency) && !missing.has(dependency)) queue.push(dependency);
		}
	}
	return { chosen, missing };
}

/** Make `target` a real directory, removing a junction or symlink but never its contents. */
function ensureRealDirectory(target, { clean }) {
	if (existsSync(target) || isLink(target)) {
		if (isLink(target)) {
			unlinkSync(target);
			console.log('  removed the stale node_modules link (its target was not touched)');
		} else if (clean) {
			rmSync(target, { recursive: true, force: true });
			console.log('  removed the existing node_modules directory (--clean)');
		}
	}
	mkdirSync(target, { recursive: true });
}

/** Whether a path is a symlink or a Windows junction. */
function isLink(path) {
	try {
		lstatSync(path);
	} catch {
		return false;
	}
	try {
		readlinkSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Write one package's files under `node_modules/`. */
function extractPackage(asar, found, nodeModules, { maxBytes, onSkip }) {
	let written = 0;
	const base = found.parts.join('/');
	for (const [path, entry] of filesOf(found.node)) {
		if (entry.size > maxBytes) {
			onSkip(found.name + '/' + path);
			continue;
		}
		const buffer = readEntry(asar, base + '/' + path, entry);
		if (buffer === undefined) {
			onSkip(found.name + '/' + path + ' (unpacked payload missing)');
			continue;
		}
		const destination = join(nodeModules, ...(found.name + '/' + path).split('/'));
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, buffer);
		written += 1;
	}
	return written;
}

/**
 * Run npm.
 *
 * Windows cannot `execFile` an `npm.cmd` shim on current Node, so npm's JS entry
 * beside this Node installation is preferred; the shim is only a shell fallback.
 * @param args - npm arguments.
 * @param options - spawn options.
 */
function runNpm(args, options) {
	const beside = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
	if (existsSync(beside)) return execFileSync(process.execPath, [beside, ...args], options);
	return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { ...options, shell: process.platform === 'win32' });
}

/**
 * Add react and react-dom so the card render tests are not skipped.
 *
 * The install happens in a scratch directory and is copied in afterwards: an
 * `npm install` rooted at this package would reify `node_modules/` against
 * `package.json` and prune the harness closure just extracted into it.
 * @param nodeModules - the closure directory.
 * @returns a one-line report.
 */
function installReact(nodeModules) {
	const scratch = join(packageDir, '.card-test-modules');
	rmSync(scratch, { recursive: true, force: true });
	mkdirSync(scratch, { recursive: true });
	try {
		runNpm([
			'install', '--no-save', '--no-audit', '--no-fund', '--prefix', scratch,
			...Object.entries(REACT_RANGE).map(([name, version]) => name + '@' + version),
		], { stdio: 'ignore', cwd: scratch });
		const source = join(scratch, 'node_modules');
		const copied = [];
		for (const entry of readdirSync(source, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			cpSync(join(source, entry.name), join(nodeModules, entry.name), { recursive: true });
			copied.push(entry.name);
		}
		return 'copied ' + copied.join(', ');
	} catch (error) {
		return 'FAILED (' + String(error?.message ?? error).split('\n')[0] + ') - card render tests will be skipped';
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help === true) {
		usage();
		return;
	}
	const asarPath = locateAsar(options.asar);
	if (asarPath === undefined) {
		console.error('No DSH payload found. Pass --asar <path to resources/app.asar>.');
		console.error('Tip: find it from the running app - the desktop process has an --app-path argument,');
		console.error('or look under <install dir>/resources/app.asar.');
		process.exitCode = 2;
		return;
	}
	const asar = openAsar(asarPath);
	const index = indexPackages(asar.header);
	const harnessManifest = index.get('@deepseek-ai/dsh');
	const harnessVersion = harnessManifest === undefined
		? 'unknown'
		: JSON.parse(readEntry(asar, harnessManifest.parts.join('/') + '/package.json', filesOf(harnessManifest.node).get('package.json')).toString('utf8')).version;

	const { chosen, missing } = resolveClosure(asar, index, options.seeds);
	const nodeModules = join(packageDir, 'node_modules');

	if (options.dryRun) {
		console.log('payload        : ' + asarPath);
		console.log('harness version: ' + harnessVersion);
		console.log('closure        : ' + chosen.size + ' packages');
		console.log('  ' + [...chosen.keys()].sort().join('\n  '));
		if (missing.size > 0) console.log('not in payload : ' + [...missing].sort().join(', '));
		closeSync(asar.fd);
		return;
	}

	console.log('payload        : ' + asarPath);
	console.log('harness version: ' + harnessVersion);
	console.log('closure        : ' + chosen.size + ' packages');
	ensureRealDirectory(nodeModules, { clean: options.clean });

	const maxBytes = options.maxFileMb * 1024 * 1024;
	const skipped = [];
	let files = 0;
	for (const found of [...chosen.values()].sort((a, b) => a.name.localeCompare(b.name))) {
		files += extractPackage(asar, found, nodeModules, { maxBytes, onSkip: (what) => skipped.push(what) });
	}
	closeSync(asar.fd);

	let react = 'not requested';
	if (options.withReact) react = installReact(nodeModules);

	writeFileSync(join(nodeModules, RUNTIME_MANIFEST), JSON.stringify({
		schemaVersion: 1,
		source: asarPath,
		harnessVersion,
		seeds: options.seeds,
		packages: [...chosen.keys()].sort(),
		files,
		skipped,
		react: options.withReact ? REACT_RANGE : undefined,
	}, undefined, 2) + '\n');

	const summary = {
		payload: asarPath,
		harnessVersion,
		packages: chosen.size,
		files,
		skipped: skipped.length,
		missing: [...missing].sort(),
		react,
	};
	if (options.json) console.log(JSON.stringify(summary, undefined, 2));
	else {
		console.log('wrote          : ' + files + ' files into node_modules/');
		console.log('react          : ' + react);
		if (skipped.length > 0) console.log('skipped        : ' + skipped.length + ' oversized/unpacked files (see ' + RUNTIME_MANIFEST + ')');
		if (missing.size > 0) console.log('not in payload : ' + [...missing].sort().join(', '));
		console.log('\nNext: npm test');
	}
}

main();
