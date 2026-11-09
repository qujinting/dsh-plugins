#!/usr/bin/env node
/**
 * Install (or remove) dsh-web-search-clinepass in one dsh profile.
 *
 * A profile composes its plugin tree from dsh.profile.bundles in its
 * package.json plus its own cordis.patch.yml. This package is a bundle, so the
 * installer only has to (1) make the package resolvable from the profile
 * directory and (2) name it as a bundle. Everything else - pointing the web
 * seam's search capability at this provider, and mounting the provider row -
 * comes from the bundle's own cordis.patch.yml.
 *
 * It also keeps this package's own dependency root working. dsh links an
 * out-of-tree bundle into the profile with a junction, so the module actually
 * runs from its real location here; its bare imports (@deepseek-ai/dsh-web,
 * @deepseek-ai/schemastery, ...) then resolve by walking up from HERE, not from
 * the profile. A node_modules junction to the harness profile module closure is
 * what makes that walk succeed, and the post-install import check proves it.
 *
 * Usage:
 *   node install.mjs [--profile web] [--home <dsh-home>] [--dry-run]
 *   node install.mjs --profile web --uninstall
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_NAME = 'dsh-web-search-clinepass';
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
	const options = { profile: 'web', home: process.env.DSH_HOME ?? join(homedir(), '.dsh'), uninstall: false, dryRun: false, dependency: true };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--profile' || arg === '-p') options.profile = argv[++i];
		else if (arg === '--home') options.home = argv[++i];
		else if (arg === '--uninstall' || arg === '-u') options.uninstall = true;
		else if (arg === '--dry-run') options.dryRun = true;
		else if (arg === '--no-dependency') options.dependency = false;
		else if (arg === '--help' || arg === '-h') options.help = true;
		else throw new Error('unknown argument: ' + arg);
	}
	return options;
}

function usage() {
	console.log([
		'Install dsh-web-search-clinepass into a dsh profile.',
		'',
		'  node install.mjs [--profile web] [--home <dsh-home>] [--dry-run] [--no-dependency]',
		'  node install.mjs --profile web --uninstall',
	].join('\n'));
}

/** Read a JSON file, tolerating a byte-order mark. */
function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
}

/** Persist the profile manifest after backing it up once per run. */
function writeJson(path, value, label, dryRun) {
	const backup = path + '.bak-' + label + '-' + Date.now();
	if (!dryRun) {
		copyFileSync(path, backup);
		writeFileSync(path, JSON.stringify(value, undefined, 2) + '\n');
	}
	console.log('  package.json   : ' + (dryRun ? 'would update' : 'updated') + ' (backup: ' + backup + ')');
}

/** Create a directory junction at target -> source, replacing a stale link. */
function link(source, target, dryRun, what) {
	let stat;
	try {
		stat = lstatSync(target);
	} catch {
		stat = undefined;
	}
	if (stat !== undefined) {
		if (!stat.isSymbolicLink()) {
			console.log('  ' + what + ': kept existing non-link ' + target);
			return false;
		}
		if (!dryRun) unlinkSync(target);
	}
	if (dryRun) {
		console.log('  ' + what + ': would link ' + target + ' -> ' + source);
		return true;
	}
	mkdirSync(dirname(target), { recursive: true });
	symlinkSync(source, target, 'junction');
	console.log('  ' + what + ': linked ' + target + ' -> ' + source);
	return true;
}

/**
 * Make this package's own bare imports resolvable from its real location.
 * Only ever adds a link where nothing exists, so a real dependency tree is
 * never touched.
 */
function ensureDependencyRoot(home, dryRun) {
	const target = join(packageDir, 'node_modules');
	if (existsSync(target)) {
		console.log('  dependencies   : ' + target + ' already present');
		return;
	}
	const closure = join(home, 'profiles', 'node_modules');
	if (!existsSync(closure)) {
		console.log('  dependencies   : WARNING no harness module closure at ' + closure + '; this package cannot import @deepseek-ai/* without one');
		return;
	}
	link(closure, target, dryRun, 'dependencies  ');
}

/** Import the package entry exactly as the loader will, and report failure loud. */
async function verifyImport(dryRun) {
	if (dryRun) {
		console.log('  import check   : skipped under --dry-run');
		return;
	}
	const manifest = readJson(join(packageDir, 'package.json'));
	const entry = join(packageDir, manifest.main ?? 'index.js');
	try {
		const module = await import(pathToFileURL(entry).href);
		if (typeof module.apply !== 'function' || typeof module.name !== 'string') throw new Error('the module exports no apply()/name');
		console.log('  import check   : ok (' + module.name + ', inject ' + JSON.stringify(module.inject) + ')');
		const clientEntry = manifest.dsh?.client === undefined ? undefined : manifest.exports?.['./client'];
		if (clientEntry !== undefined) {
			const clientPath = join(packageDir, clientEntry);
			if (!existsSync(clientPath)) throw new Error('the manifest declares dsh.client but ' + clientPath + ' is missing; the host would serve no browser half');
			console.log('  browser half   : ok (' + clientEntry + ', ' + readFileSync(clientPath, 'utf8').length + ' bytes)');
		}
	} catch (error) {
		throw new Error('installed, but the module cannot be imported from ' + packageDir + ': ' + (error instanceof Error ? error.message : String(error)) + '. Fix the dependency root above, then re-run this installer.');
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) return usage();
	const dir = join(options.home, 'profiles', options.profile);
	const manifestPath = join(dir, 'package.json');
	if (!existsSync(manifestPath)) {
		throw new Error('profile "' + options.profile + '" not found at ' + dir + '. Start it once (for example `dsh --profile ' + options.profile + '`) so dsh initializes the profile directory.');
	}
	const linkPath = join(dir, 'node_modules', PACKAGE_NAME);
	if (options.uninstall) {
		console.log('Removing ' + PACKAGE_NAME + ' from profile "' + options.profile + '" (' + dir + ')');
		if (existsSync(linkPath)) {
			if (!options.dryRun) unlinkSync(linkPath);
			console.log('  node_modules   : ' + (options.dryRun ? 'would remove' : 'removed') + ' ' + linkPath);
		} else console.log('  node_modules   : nothing to remove');
		const manifest = readJson(manifestPath);
		let changed = false;
		const bundles = manifest.dsh?.profile?.bundles;
		if (Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)) {
			manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== PACKAGE_NAME);
			changed = true;
		} else console.log('  package.json   : bundle already absent');
		if (manifest.dependencies !== undefined && manifest.dependencies[PACKAGE_NAME] !== undefined) {
			delete manifest.dependencies[PACKAGE_NAME];
			console.log('  package.json   : dependency entry removed');
			changed = true;
		}
		if (changed) writeJson(manifestPath, manifest, 'uninstall', options.dryRun);
		console.log('\nRestart dsh for the change to take effect. The dependency root under the package directory is left in place.');
		return;
	}
	console.log('Installing ' + PACKAGE_NAME + ' into profile "' + options.profile + '" (' + dir + ')');
	link(packageDir, linkPath, options.dryRun, 'node_modules  ');
	ensureDependencyRoot(options.home, options.dryRun);
	const manifest = readJson(manifestPath);
	manifest.dsh = manifest.dsh ?? {};
	manifest.dsh.profile = manifest.dsh.profile ?? {};
	const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
	let changed = false;
	if (!bundles.includes(PACKAGE_NAME)) {
		manifest.dsh.profile.bundles = [...bundles, PACKAGE_NAME];
		changed = true;
	}
	if (options.dependency) {
		manifest.dependencies = manifest.dependencies ?? {};
		if (manifest.dependencies[PACKAGE_NAME] === undefined) {
			manifest.dependencies[PACKAGE_NAME] = 'file:' + packageDir.replace(/\\/gu, '/');
			changed = true;
		}
	}
	if (changed) writeJson(manifestPath, manifest, 'install', options.dryRun);
	else console.log('  package.json   : already listed (' + PACKAGE_NAME + ' in dsh.profile.bundles)');
	await verifyImport(options.dryRun);
	console.log('\n' + (options.dryRun ? 'Dry run only; nothing was written.' : 'Installed. The bundle layer points web.searchProvider at "clinepass" and mounts the provider row.'));
	console.log('Restart dsh (for example `dsh web`) to load it, then run any web_search call.');
	console.log('Verify composition without booting: dsh --profile ' + options.profile + ' --dump-config');
}

try {
	await main();
} catch (error) {
	console.error('install failed: ' + (error instanceof Error ? error.message : String(error)));
	process.exitCode = 1;
}
