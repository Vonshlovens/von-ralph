import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const RALPH_DIR = join(homedir(), '.ralph');
const PID_DIR = join(RALPH_DIR, 'pids');
const LOG_DIR = join(RALPH_DIR, 'logs');
async function findRalphBin(): Promise<string> {
	if (process.env.RALPH_BIN) return process.env.RALPH_BIN;
	try {
		const { stdout } = await execAsync('which ralph');
		const p = stdout.trim();
		if (p) return p;
	} catch { /* not in PATH */ }
	return 'ralph';
}

export interface RalphInstance {
	name: string;
	pid: number;
	prompt: string;
	maxRuns: number;
	model: string;
	workDir: string;
	marathon: boolean;
	started: string;
	currentRun: number;
	alive: boolean;
	logFile: string;
	logSize: number;
}

export interface RalphLog {
	name: string;
	path: string;
	size: number;
	modified: string;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function isProcessAlive(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function signalPath(name: string): string {
	return join(PID_DIR, `${name}.signal`);
}

function parseMeta(content: string): Record<string, string> {
	const meta: Record<string, string> = {};
	for (const line of content.split('\n')) {
		const eq = line.indexOf('=');
		if (eq > 0) {
			meta[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
		}
	}
	return meta;
}

export async function listInstances(): Promise<RalphInstance[]> {
	const instances: RalphInstance[] = [];
	const knownNames = new Set<string>();

	// 1. Active instances from meta files
	if (await fileExists(PID_DIR)) {
		const files = await readdir(PID_DIR);
		const metaFiles = files.filter((f) => f.endsWith('.meta'));

		for (const file of metaFiles) {
			try {
				const content = await readFile(join(PID_DIR, file), 'utf-8');
				const meta = parseMeta(content);
				const pid = parseInt(meta.pid || '0');
				const name = meta.name || file.replace('.meta', '');
				knownNames.add(name);
				const logFile = join(LOG_DIR, `${name}.log`);
				let logSize = 0;
				try {
					const s = await stat(logFile);
					logSize = s.size;
				} catch { /* no log yet */ }

				instances.push({
					name,
					pid,
					prompt: meta.prompt || '',
					maxRuns: parseInt(meta.max_runs || '0'),
					model: meta.model || 'opus',
					workDir: meta.work_dir || '',
					marathon: meta.marathon === 'true',
					started: meta.started || '',
					currentRun: parseInt(meta.current_run || '0'),
					alive: await isProcessAlive(pid),
					logFile,
					logSize
				});
			} catch { /* skip corrupt meta */ }
		}
	}

	// 2. Discover orphan logs (finished ralphs with no meta)
	if (await fileExists(LOG_DIR)) {
		const logFiles = await readdir(LOG_DIR);
		for (const file of logFiles.filter((f) => f.endsWith('.log'))) {
			const name = file.replace('.log', '');
			if (knownNames.has(name)) continue;

			try {
				const logFile = join(LOG_DIR, file);
				const s = await stat(logFile);
				instances.push({
					name,
					pid: 0,
					prompt: '(finished — check log)',
					maxRuns: 0,
					model: '?',
					workDir: '',
					marathon: false,
					started: s.mtime.toISOString(),
					currentRun: 0,
					alive: false,
					logFile,
					logSize: s.size
				});
			} catch { /* skip */ }
		}
	}

	return instances.sort((a, b) => b.started.localeCompare(a.started));
}

export async function getLogTail(name: string, lines: number = 100): Promise<string> {
	const logFile = join(LOG_DIR, `${name}.log`);
	if (!(await fileExists(logFile))) return '';

	try {
		const { stdout } = await execAsync(`tail -n ${lines} ${JSON.stringify(logFile)}`);
		return stdout;
	} catch {
		return '';
	}
}

export async function getFullLog(name: string): Promise<string> {
	const logFile = join(LOG_DIR, `${name}.log`);
	if (!(await fileExists(logFile))) return '';
	return readFile(logFile, 'utf-8');
}

export async function listLogs(): Promise<RalphLog[]> {
	if (!(await fileExists(LOG_DIR))) return [];

	const files = await readdir(LOG_DIR);
	const logs: RalphLog[] = [];

	for (const file of files.filter((f) => f.endsWith('.log'))) {
		try {
			const path = join(LOG_DIR, file);
			const s = await stat(path);
			logs.push({
				name: file.replace('.log', ''),
				path,
				size: s.size,
				modified: s.mtime.toISOString()
			});
		} catch { /* skip */ }
	}

	return logs.sort((a, b) => b.modified.localeCompare(a.modified));
}

export async function killInstance(name: string): Promise<{ success: boolean; message: string }> {
	const metaFile = join(PID_DIR, `${name}.meta`);
	if (!(await fileExists(metaFile))) {
		return { success: false, message: `No ralph named '${name}' found` };
	}

	const content = await readFile(metaFile, 'utf-8');
	const meta = parseMeta(content);
	const pid = parseInt(meta.pid || '0');

	if (!(await isProcessAlive(pid))) {
		// Clean up stale files
		await cleanMeta(name);
		return { success: true, message: `${name} was already dead (cleaned up)` };
	}

	try {
		// Kill process group
		process.kill(-pid, 'SIGTERM');
	} catch { /* ignore */ }
	try {
		process.kill(pid, 'SIGTERM');
	} catch { /* ignore */ }

	return { success: true, message: `Killed ${name} (PID ${pid})` };
}

export async function killAll(): Promise<{ killed: string[]; alreadyDead: string[] }> {
	const instances = await listInstances();
	const killed: string[] = [];
	const alreadyDead: string[] = [];

	for (const inst of instances) {
		if (inst.alive) {
			await killInstance(inst.name);
			killed.push(inst.name);
		} else {
			await cleanMeta(inst.name);
			alreadyDead.push(inst.name);
		}
	}

	return { killed, alreadyDead };
}

async function cleanMeta(name: string) {
	try { await readFile(join(PID_DIR, `${name}.meta`)); } catch { return; }
	const { unlink } = await import('node:fs/promises');
	try { await unlink(join(PID_DIR, `${name}.meta`)); } catch { /* ok */ }
	try { await unlink(join(PID_DIR, `${name}.pid`)); } catch { /* ok */ }
	try { await unlink(signalPath(name)); } catch { /* ok */ }
}

export async function cleanDead(): Promise<string[]> {
	const instances = await listInstances();
	const cleaned: string[] = [];

	for (const inst of instances) {
		if (!inst.alive) {
			await cleanMeta(inst.name);
			cleaned.push(inst.name);
		}
	}

	return cleaned;
}

export async function injectPrompt(name: string, prompt: string): Promise<{ success: boolean; message: string }> {
	const instanceName = name.trim();
	const message = prompt.trim();

	if (!instanceName) {
		return { success: false, message: 'instance name cannot be empty' };
	}
	if (!message) {
		return { success: false, message: 'prompt injection cannot be empty' };
	}

	const metaFile = join(PID_DIR, `${instanceName}.meta`);
	if (!(await fileExists(metaFile))) {
		return { success: false, message: `No ralph named '${instanceName}' found` };
	}

	const content = await readFile(metaFile, 'utf-8');
	const meta = parseMeta(content);
	const pid = parseInt(meta.pid || '0');
	if (!(await isProcessAlive(pid))) {
		return { success: false, message: `${instanceName} is not running` };
	}

	try {
		await writeFile(signalPath(instanceName), message, { flag: 'wx' });
		return { success: true, message: `Queued prompt injection for ${instanceName}` };
	} catch (err) {
		if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
			return {
				success: false,
				message: 'prompt injection already queued; wait for ralph to consume it'
			};
		}
		throw err;
	}
}

export interface SpawnOptions {
	prompt?: string;
	maxRuns?: number;
	name?: string;
	dir?: string;
	model?: string;
	marathon?: boolean;
}

export async function spawnRalph(opts: SpawnOptions): Promise<{ name: string; pid: number }> {
	const RALPH_BIN = await findRalphBin();
	const args: string[] = [];

	if (opts.prompt) {
		args.push(opts.prompt);
	}
	if (opts.maxRuns && opts.maxRuns > 0) {
		args.push(String(opts.maxRuns));
	}
	if (opts.name) {
		args.push('-n', opts.name);
	}
	if (opts.dir) {
		args.push('-d', opts.dir);
	}
	if (opts.model) {
		args.push('-m', opts.model);
	}
	if (opts.marathon) {
		args.push('--marathon');
	}

	const child = spawn(RALPH_BIN, args, {
		detached: true,
		stdio: 'ignore',
		cwd: opts.dir || homedir(),
		shell: true
	});

	child.unref();
	const pid = child.pid || 0;
	const name = opts.name || `ralph-spawned-${pid}`;

	return { name, pid };
}
