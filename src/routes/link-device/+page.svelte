<script lang="ts">
	import { onMount } from 'svelte';
	import { deriveKeyFromPassphrase, encryptSymmetric, decryptSymmetric, decode } from '$lib/crypto';
	import { loadMemberships, hasMemberships, saveMembership } from '$lib/client/key-store';
	import QrCode from '$lib/components/QrCode.svelte';
	import type { StoredMembership } from '$lib/client/key-store';

	export const ssr = false;

	type Tab = 'link' | 'export' | 'import';
	let activeTab = $state<Tab>('link');

	// ── shared ────────────────────────────────────────────────────────────
	type PageMode = 'loading' | 'ready' | 'nokeys';
	let mode = $state<PageMode>('loading');

	// ── link tab ──────────────────────────────────────────────────────────
	type LinkStep = 'form' | 'generated';
	let linkStep = $state<LinkStep>('form');
	let linkPassphrase = $state('');
	let linkPassphraseConfirm = $state('');
	let linkError = $state('');
	let generating = $state(false);
	let importUrl = $state('');

	// ── export tab ────────────────────────────────────────────────────────
	let exportPassphrase = $state('');
	let exportPassphraseConfirm = $state('');
	let exportError = $state('');
	let exporting = $state(false);

	// ── import tab ────────────────────────────────────────────────────────
	let importFile = $state<File | null>(null);
	let importPassphrase = $state('');
	let importError = $state('');
	let importSuccess = $state(false);
	let importing = $state(false);

	onMount(() => {
		mode = hasMemberships() ? 'ready' : 'nokeys';
	});

	// ── link tab handlers ─────────────────────────────────────────────────

	async function handleGenerateLink(e: SubmitEvent) {
		e.preventDefault();
		linkError = '';
		if (linkPassphrase.length < 8) { linkError = 'Passphrase must be at least 8 characters'; return; }
		if (linkPassphrase !== linkPassphraseConfirm) { linkError = 'Passphrases do not match'; return; }

		generating = true;
		try {
			const memberships = loadMemberships();
			const { key, saltB64 } = await deriveKeyFromPassphrase(linkPassphrase);
			const encrypted = await encryptSymmetric(key, new TextEncoder().encode(JSON.stringify(memberships)));
			const fragment = btoa(JSON.stringify({ v: 2, salt: saltB64, encrypted }))
				.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
			importUrl = `${window.location.origin}/import#${fragment}`;
			linkStep = 'generated';
		} catch { linkError = 'Failed to generate link'; }
		finally { generating = false; }
	}

	// ── export tab handler ────────────────────────────────────────────────

	async function handleExport(e: SubmitEvent) {
		e.preventDefault();
		exportError = '';
		if (exportPassphrase.length < 8) { exportError = 'Passphrase must be at least 8 characters'; return; }
		if (exportPassphrase !== exportPassphraseConfirm) { exportError = 'Passphrases do not match'; return; }

		exporting = true;
		try {
			const memberships = loadMemberships();
			const { key, saltB64 } = await deriveKeyFromPassphrase(exportPassphrase);
			const encrypted = await encryptSymmetric(key, new TextEncoder().encode(JSON.stringify(memberships)));
			const fileData = JSON.stringify({ v: 2, salt: saltB64, encrypted }, null, 2);
			const blob = new Blob([fileData], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = 'witness-backup.json';
			a.click();
			URL.revokeObjectURL(url);
		} catch { exportError = 'Export failed'; }
		finally { exporting = false; }
	}

	// ── import tab handler ────────────────────────────────────────────────

	async function handleImport(e: SubmitEvent) {
		e.preventDefault();
		importError = '';
		if (!importFile) { importError = 'Please select a backup file'; return; }

		importing = true;
		try {
			const text = await importFile.text();
			let parsed: { v: number; salt: string; encrypted: string };
			try {
				parsed = JSON.parse(text) as typeof parsed;
				if (!parsed.v || !parsed.salt || !parsed.encrypted) throw new Error('missing fields');
			} catch {
				importError = 'Invalid backup file — missing required fields';
				return;
			}

			if (parsed.v === 1) {
				importError = 'Legacy backup (v1) cannot be restored without project context. Please re-register using your invite link.';
				return;
			}

			const saltBytes = decode(parsed.salt);
			const { key } = await deriveKeyFromPassphrase(importPassphrase, { salt: saltBytes });

			let memberships: Record<string, StoredMembership>;
			try {
				const plaintext = await decryptSymmetric(key, parsed.encrypted);
				memberships = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, StoredMembership>;
			} catch {
				importError = 'Wrong passphrase — decryption failed';
				return;
			}

			// Merge imported memberships (don't overwrite existing)
			for (const [projectId, m] of Object.entries(memberships)) {
				saveMembership(projectId, m.bundle, m.projectName, m.role);
			}
			importSuccess = true;
		} catch (err) {
			importError = err instanceof Error ? err.message : 'Import failed';
		} finally {
			importing = false;
		}
	}
</script>

<svelte:head><title>Witness – Key Management</title></svelte:head>

<div class="mx-auto max-w-lg p-6 flex flex-col gap-6">
	<div>
		<a href="/dashboard" class="text-sm text-base-content/50 hover:text-base-content mb-2 inline-block">← Dashboard</a>
		<h1 class="text-2xl font-bold">Key management</h1>
	</div>

	{#if mode === 'loading'}
		<div class="flex justify-center"><span class="loading loading-spinner loading-lg"></span></div>

	{:else if mode === 'nokeys'}
		<div role="alert" class="alert alert-warning">
			<span>No memberships found. Please join a project first.</span>
		</div>

	{:else}
		<div role="tablist" class="tabs tabs-bordered">
			<button role="tab" class="tab {activeTab === 'link' ? 'tab-active' : ''}" onclick={() => activeTab = 'link'}>Link device</button>
			<button role="tab" class="tab {activeTab === 'export' ? 'tab-active' : ''}" onclick={() => activeTab = 'export'}>Export backup</button>
			<button role="tab" class="tab {activeTab === 'import' ? 'tab-active' : ''}" onclick={() => activeTab = 'import'}>Import backup</button>
		</div>

		{#if activeTab === 'link'}
			<p class="text-base-content/60 text-sm">Generate a QR link to securely transfer your memberships to another device in real-time.</p>

			{#if linkStep === 'form'}
				<form class="flex flex-col gap-4" onsubmit={handleGenerateLink}>
					<label class="flex flex-col gap-1">
						<span class="label-text font-medium">Passphrase</span>
						<input type="password" class="input input-bordered" placeholder="At least 8 characters" bind:value={linkPassphrase} required minlength={8} aria-label="Passphrase" />
					</label>
					<label class="flex flex-col gap-1">
						<span class="label-text font-medium">Confirm passphrase</span>
						<input type="password" class="input input-bordered" bind:value={linkPassphraseConfirm} required aria-label="Confirm passphrase" />
					</label>
					{#if linkError}<div role="alert" class="alert alert-error text-sm"><span>{linkError}</span></div>{/if}
					<button type="submit" class="btn btn-primary" disabled={generating} data-testid="generate-link-btn">
						{#if generating}<span class="loading loading-spinner loading-sm"></span>{/if}
						Generate link
					</button>
				</form>
			{:else}
				<div class="flex flex-col gap-4">
					<div role="status" class="alert alert-success text-sm"><span>Link generated! Open it on your other device and enter the passphrase.</span></div>
					<label class="flex flex-col gap-1">
						<span class="label-text text-sm font-medium">Import link</span>
						<input type="text" readonly class="input input-bordered font-mono text-xs" value={importUrl} onclick={(e) => (e.target as HTMLInputElement).select()} aria-label="Import link URL" data-testid="import-url" />
					</label>
					<div class="flex justify-center"><QrCode value={importUrl} /></div>
					<p class="text-xs text-base-content/50 text-center">Keep the passphrase secret and do not share the link publicly.</p>
					<button class="btn btn-ghost btn-sm" onclick={() => { linkStep = 'form'; linkPassphrase = ''; linkPassphraseConfirm = ''; }}>Generate a new link</button>
				</div>
			{/if}

		{:else if activeTab === 'export'}
			<p class="text-base-content/60 text-sm">Download an encrypted backup of all your project memberships. Store the file safely — you will need the passphrase to restore it.</p>
			<form class="flex flex-col gap-4" onsubmit={handleExport}>
				<label class="flex flex-col gap-1">
					<span class="label-text font-medium">Passphrase</span>
					<input type="password" class="input input-bordered" placeholder="At least 8 characters" bind:value={exportPassphrase} required minlength={8} aria-label="Export passphrase" />
				</label>
				<label class="flex flex-col gap-1">
					<span class="label-text font-medium">Confirm passphrase</span>
					<input type="password" class="input input-bordered" bind:value={exportPassphraseConfirm} required aria-label="Confirm export passphrase" />
				</label>
				{#if exportError}<div role="alert" class="alert alert-error text-sm"><span>{exportError}</span></div>{/if}
				<button type="submit" class="btn btn-primary" disabled={exporting} data-testid="export-btn">
					{#if exporting}<span class="loading loading-spinner loading-sm"></span>{/if}
					Download backup
				</button>
			</form>

		{:else if activeTab === 'import'}
			<p class="text-base-content/60 text-sm">Restore memberships from a previously exported backup file.</p>
			{#if importSuccess}
				<div role="status" class="alert alert-success">
					<span>Memberships imported successfully!</span>
					<a href="/dashboard" class="btn btn-sm btn-ghost ml-2">Go to dashboard</a>
				</div>
			{:else}
				<form class="flex flex-col gap-4" onsubmit={handleImport}>
					<label class="flex flex-col gap-1">
						<span class="label-text font-medium">Backup file (.json)</span>
						<input type="file" accept=".json,application/json" class="file-input file-input-bordered file-input-sm"
							onchange={(e) => importFile = (e.target as HTMLInputElement).files?.[0] ?? null}
							aria-label="Backup file" data-testid="import-file-input" />
					</label>
					<label class="flex flex-col gap-1">
						<span class="label-text font-medium">Passphrase</span>
						<input type="password" class="input input-bordered" bind:value={importPassphrase} required aria-label="Import passphrase" data-testid="import-passphrase-input" />
					</label>
					{#if importError}<div role="alert" class="alert alert-error text-sm"><span>{importError}</span></div>{/if}
					<button type="submit" class="btn btn-primary" disabled={importing || !importFile} data-testid="import-file-btn">
						{#if importing}<span class="loading loading-spinner loading-sm"></span>{/if}
						Import backup
					</button>
				</form>
			{/if}
		{/if}
	{/if}
</div>
