<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	interface RalphInstance {
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

	let instances = $state<RalphInstance[]>([]);
	let selectedName = $state<string | null>(null);
	let logContent = $state('');
	let logLoading = $state(false);
	let showSpawnForm = $state(false);
	let showInjectForm = $state(false);
	let statusMessage = $state('');
	let statusError = $state('');
	let pollTimer: ReturnType<typeof setInterval>;
	let logTimer: ReturnType<typeof setInterval>;

	// Spawn form state
	let spawnPrompt = $state('');
	let spawnMaxRuns = $state(5);
	let spawnName = $state('');
	let spawnDir = $state('~/cwl-api');
	let spawnModel = $state('opus');
	let spawnMarathon = $state(false);
	let spawning = $state(false);

	let injectName = $state('');
	let injectPrompt = $state('');
	let injecting = $state(false);

	async function fetchInstances() {
		try {
			const res = await fetch('/api/instances');
			const data = await res.json();
			instances = data.instances;
		} catch { /* retry next poll */ }
	}

	async function fetchLog(name: string) {
		logLoading = true;
		try {
			const res = await fetch(`/api/logs?name=${encodeURIComponent(name)}&lines=300`);
			const data = await res.json();
			logContent = data.log || '(empty)';
		} catch {
			logContent = '(failed to fetch log)';
		}
		logLoading = false;
	}

	function selectInstance(name: string) {
		if (selectedName === name) {
			selectedName = null;
			logContent = '';
			clearInterval(logTimer);
			return;
		}
		selectedName = name;
		fetchLog(name);
		clearInterval(logTimer);
		logTimer = setInterval(() => {
			if (selectedName) fetchLog(selectedName);
		}, 3000);
	}

	async function killRalph(name: string) {
		await fetch('/api/kill', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name })
		});
		await fetchInstances();
	}

	async function killAllRalphs() {
		await fetch('/api/kill', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'all' })
		});
		await fetchInstances();
	}

	async function cleanDead() {
		await fetch('/api/instances', { method: 'POST' });
		await fetchInstances();
	}

	async function spawnRalph() {
		spawning = true;
		try {
			await fetch('/api/spawn', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					prompt: spawnPrompt || undefined,
					maxRuns: spawnMaxRuns || undefined,
					name: spawnName || undefined,
					dir: spawnDir || undefined,
					model: spawnModel,
					marathon: spawnMarathon
				})
			});
			showSpawnForm = false;
			spawnPrompt = '';
			spawnName = '';
			// Give it a moment to register
			setTimeout(fetchInstances, 1500);
		} finally {
			spawning = false;
		}
	}

	function openInjectForm(name: string) {
		injectName = name;
		injectPrompt = '';
		statusMessage = '';
		statusError = '';
		showInjectForm = true;
	}

	function closeInjectForm() {
		showInjectForm = false;
		injectPrompt = '';
	}

	async function injectIntoRalph() {
		statusMessage = '';
		statusError = '';

		if (!injectPrompt.trim()) {
			statusError = 'prompt injection cannot be empty';
			return;
		}

		injecting = true;
		try {
			const res = await fetch('/api/inject', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: injectName, prompt: injectPrompt })
			});
			const data = await res.json();
			if (!res.ok || !data.success) {
				statusError = data.message || 'failed to queue prompt injection';
				return;
			}
			statusMessage = data.message;
			closeInjectForm();
		} catch {
			statusError = 'failed to queue prompt injection';
		} finally {
			injecting = false;
		}
	}

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes}B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
		return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
	}

	function timeAgo(isoStr: string): string {
		if (!isoStr) return '?';
		const diff = Date.now() - new Date(isoStr).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
		return `${Math.floor(hrs / 24)}d ago`;
	}

	function truncate(s: string, n: number): string {
		return s.length > n ? s.slice(0, n) + '...' : s;
	}

	onMount(() => {
		fetchInstances();
		pollTimer = setInterval(fetchInstances, 5000);
	});

	onDestroy(() => {
		clearInterval(pollTimer);
		clearInterval(logTimer);
	});

	let aliveCount = $derived(instances.filter((i) => i.alive).length);
	let deadCount = $derived(instances.filter((i) => !i.alive).length);
	let selectedInstance = $derived(instances.find((i) => i.name === selectedName));
</script>

<div class="flex flex-col h-[calc(100vh-53px)]">
	<!-- Stats bar -->
	<div class="border-b border-border px-6 py-2.5 flex items-center gap-6 text-sm">
		<div class="flex items-center gap-2">
			<span class="w-2 h-2 rounded-full bg-green pulse-dot"></span>
			<span class="text-text-muted">{aliveCount} running</span>
		</div>
		<div class="flex items-center gap-2">
			<span class="w-2 h-2 rounded-full bg-red opacity-50"></span>
			<span class="text-text-muted">{deadCount} dead</span>
		</div>
		<div class="flex-1"></div>
		<button
			class="px-3 py-1 text-xs rounded bg-accent hover:bg-accent-hover text-white transition-colors"
			onclick={() => (showSpawnForm = !showSpawnForm)}
		>
			+ spawn ralph
		</button>
		{#if deadCount > 0}
			<button
				class="px-3 py-1 text-xs rounded bg-surface hover:bg-surface-hover text-text-muted border border-border transition-colors"
				onclick={cleanDead}
			>
				clean dead
			</button>
		{/if}
		{#if aliveCount > 0}
			<button
				class="px-3 py-1 text-xs rounded bg-red/10 hover:bg-red/20 text-red border border-red/20 transition-colors"
				onclick={killAllRalphs}
			>
				kill all
			</button>
		{/if}
	</div>

	{#if statusMessage || statusError}
		<div class="border-b border-border px-6 py-2 text-xs {statusError ? 'text-red bg-red/10' : 'text-green bg-green/10'}">
			{statusError || statusMessage}
		</div>
	{/if}

	<!-- Spawn form -->
	{#if showSpawnForm}
		<div class="border-b border-border px-6 py-4 bg-surface">
			<div class="grid grid-cols-2 md:grid-cols-3 gap-3 max-w-4xl">
				<div class="col-span-2 md:col-span-3">
					<label class="block text-xs text-text-muted mb-1">prompt (empty = default /tackle)
					<textarea
						bind:value={spawnPrompt}
						class="w-full bg-bg border border-border rounded px-3 py-2 text-sm text-text resize-none focus:outline-none focus:border-accent"
						rows="2"
						placeholder="See AGENT_PROMPT.md"
					></textarea>
					</label>
				</div>
				<div>
					<label class="block text-xs text-text-muted mb-1">name
					<input
						bind:value={spawnName}
						class="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm text-text focus:outline-none focus:border-accent"
						placeholder="auto-generated"
					/>
					</label>
				</div>
				<div>
					<label class="block text-xs text-text-muted mb-1">directory
					<input
						bind:value={spawnDir}
						class="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm text-text focus:outline-none focus:border-accent"
					/>
					</label>
				</div>
				<div>
					<label class="block text-xs text-text-muted mb-1">model
					<select
						bind:value={spawnModel}
						class="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm text-text focus:outline-none focus:border-accent"
					>
						<option value="opus">opus</option>
						<option value="sonnet">sonnet</option>
						<option value="haiku">haiku</option>
					</select>
					</label>
				</div>
				<div>
					<label class="block text-xs text-text-muted mb-1">max runs
					<input
						bind:value={spawnMaxRuns}
						type="number"
						min="0"
						class="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm text-text focus:outline-none focus:border-accent"
					/>
					</label>
				</div>
				<div class="flex items-end gap-3">
					<label class="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
						<input type="checkbox" bind:checked={spawnMarathon} class="accent-accent" />
						marathon
					</label>
				</div>
				<div class="flex items-end">
					<button
						class="px-4 py-1.5 text-sm rounded bg-accent hover:bg-accent-hover text-white transition-colors disabled:opacity-50"
						onclick={spawnRalph}
						disabled={spawning}
					>
						{spawning ? 'spawning...' : 'launch'}
					</button>
				</div>
			</div>
		</div>
	{/if}

	{#if showInjectForm}
		<div class="border-b border-border px-6 py-4 bg-surface">
			<div class="max-w-4xl">
				<div class="flex items-center gap-3 mb-2">
					<div class="text-sm font-medium text-text">inject into {injectName}</div>
					<div class="flex-1"></div>
					<button
						class="px-2 py-0.5 text-xs rounded bg-bg hover:bg-surface-hover text-text-muted border border-border transition-colors"
						onclick={closeInjectForm}
					>
						cancel
					</button>
				</div>
				<label class="block text-xs text-text-muted mb-2">prompt for next loop
					<textarea
						bind:value={injectPrompt}
						class="w-full bg-bg border border-border rounded px-3 py-2 text-sm text-text resize-none focus:outline-none focus:border-accent"
						rows="3"
						placeholder="Check current status and adjust course..."
					></textarea>
				</label>
				<button
					class="px-4 py-1.5 text-sm rounded bg-accent hover:bg-accent-hover text-white transition-colors disabled:opacity-50"
					onclick={injectIntoRalph}
					disabled={injecting}
				>
					{injecting ? 'queueing...' : 'queue injection'}
				</button>
			</div>
		</div>
	{/if}

	<div class="flex flex-1 min-h-0">
		<!-- Instance list -->
		<div class="w-96 border-r border-border overflow-y-auto shrink-0">
			{#if instances.length === 0}
				<div class="p-6 text-center text-text-dim text-sm">
					No ralph instances found.
					<br />
					<span class="text-xs">Spawn one or run <code class="text-accent">ralph</code> from the CLI.</span>
				</div>
			{/if}
			{#each instances as inst (inst.name)}
				<button
					class="w-full text-left px-4 py-3 border-b border-border transition-colors
						{selectedName === inst.name ? 'bg-surface-hover' : 'hover:bg-surface'}"
					onclick={() => selectInstance(inst.name)}
				>
					<div class="flex items-center gap-2 mb-1">
						{#if inst.alive}
							<span class="w-2 h-2 rounded-full bg-green pulse-dot shrink-0"></span>
						{:else}
							<span class="w-2 h-2 rounded-full bg-red opacity-50 shrink-0"></span>
						{/if}
						<span class="font-medium text-sm text-text truncate">{inst.name}</span>
						<span class="ml-auto text-xs text-text-dim shrink-0">{timeAgo(inst.started)}</span>
					</div>
					<div class="ml-4 text-xs text-text-muted truncate">{truncate(inst.prompt, 70)}</div>
					<div class="ml-4 mt-1 flex items-center gap-3 text-xs text-text-dim">
						<span class="px-1.5 py-0.5 rounded bg-surface border border-border">{inst.model}</span>
						<span>run {inst.currentRun || '?'}{inst.maxRuns > 0 ? `/${inst.maxRuns}` : ''}</span>
						{#if inst.marathon}
							<span class="text-yellow">marathon</span>
						{/if}
						<span class="ml-auto">{formatSize(inst.logSize)}</span>
					</div>
				</button>
			{/each}
		</div>

		<!-- Log viewer -->
		<div class="flex-1 flex flex-col min-h-0">
			{#if selectedName}
				<div class="border-b border-border px-4 py-2 flex items-center gap-3 bg-surface shrink-0">
					<span class="text-sm font-medium text-text">{selectedName}</span>
					{#if selectedInstance}
						<span class="text-xs text-text-dim">{selectedInstance.workDir}</span>
					{/if}
					<div class="flex-1"></div>
					{#if logLoading}
						<span class="text-xs text-text-dim">refreshing...</span>
					{/if}
					{#if selectedInstance?.alive}
						<button
							class="px-2 py-0.5 text-xs rounded bg-accent hover:bg-accent-hover text-white transition-colors"
							onclick={() => openInjectForm(selectedName!)}
						>
							inject
						</button>
						<button
							class="px-2 py-0.5 text-xs rounded bg-red/10 hover:bg-red/20 text-red border border-red/20 transition-colors"
							onclick={() => killRalph(selectedName!)}
						>
							kill
						</button>
					{/if}
				</div>
				<div class="flex-1 overflow-y-auto p-4 font-mono">
					{#each logContent.split('\n') as line, i (i)}
						<div class="log-line px-2 rounded whitespace-pre-wrap break-all
							{line.includes('💬') ? 'text-text' : ''}
							{line.includes('🔧') ? 'text-blue' : ''}
							{line.includes('📋') ? 'text-text-dim' : ''}
							{line.includes('RUN') && line.includes('COMPLETE') ? 'text-green font-medium' : ''}
							{line.includes('---') && line.includes('RUN') && !line.includes('COMPLETE') ? 'text-accent font-medium' : ''}
							{line.includes('🚀') ? 'text-green' : ''}
							{line.includes('🛑') ? 'text-red' : ''}
							{line.includes('⚠️') ? 'text-yellow' : ''}
							{line.includes('⏳') ? 'text-yellow' : ''}
							{line.includes('✅') ? 'text-green' : ''}
						">{line}</div>
					{/each}
				</div>
			{:else}
				<div class="flex-1 flex items-center justify-center text-text-dim text-sm">
					Select a ralph to view its logs
				</div>
			{/if}
		</div>
	</div>
</div>
