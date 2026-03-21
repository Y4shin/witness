<script lang="ts">
	import { onMount } from 'svelte';
	import { deriveKeyFromPassphrase, encryptSymmetric, decryptSymmetric, decode } from '$lib/crypto';
	import { loadMemberships, hasMemberships, saveMembership } from '$lib/client/key-store';
	import QrCode from '$lib/components/QrCode.svelte';
	import type { StoredMembership } from '$lib/client/key-store';
import * as m from '$lib/paraglide/messages';

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
		if (linkPassphrase.length < 8) { linkError = m.link_passphrase_min_chars(); return; }
		if (linkPassphrase !== linkPassphraseConfirm) { linkError = m.link_passphrases_no_match(); return; }

		generating = true;
		try {
			const memberships = loadMemberships();
			const { key, saltB64 } = await deriveKeyFromPassphrase(linkPassphrase);
			const encrypted = await encryptSymmetric(key, new TextEncoder().encode(JSON.stringify(memberships)));
			const fragment = btoa(JSON.stringify({ v: 2, salt: saltB64, encrypted }))
				.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
			importUrl = `${window.location.origin}/import#${fragment}`;
			linkStep = 'generated';
		} catch { linkError = m.link_failed_generate(); }
		finally { generating = false; }
	}

	// ── export tab handler ────────────────────────────────────────────────

	async function handleExport(e: SubmitEvent) {
		e.preventDefault();
		exportError = '';
		if (exportPassphrase.length < 8) { exportError = m.link_passphrase_min_chars(); return; }
		if (exportPassphrase !== exportPassphraseConfirm) { exportError = m.link_passphrases_no_match(); return; }

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
		} catch { exportError = m.link_export_failed(); }
		finally { exporting = false; }
	}

	// ── import tab handler ────────────────────────────────────────────────

	async function handleImport(e: SubmitEvent) {
		e.preventDefault();
		importError = '';
		if (!importFile) { importError = m.link_import_file_required(); return; }

		importing = true;
		try {
			const text = await importFile.text();
			let parsed: { v: number; salt: string; encrypted: string };
			try {
				parsed = JSON.parse(text) as typeof parsed;
				if (!parsed.v || !parsed.salt || !parsed.encrypted) throw new Error('missing fields');
			} catch {
				importError = m.link_import_invalid_file();
				return;
			}

			if (parsed.v === 1) {
				importError = m.link_legacy_backup();
				return;
			}

			const saltBytes = decode(parsed.salt);
			const { key } = await deriveKeyFromPassphrase(importPassphrase, { salt: saltBytes });

			let memberships: Record<string, StoredMembership>;
			try {
				const plaintext = await decryptSymmetric(key, parsed.encrypted);
				memberships = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, StoredMembership>;
			} catch {
				importError = m.link_import_wrong_passphrase();
				return;
			}

			// Merge imported memberships (don't overwrite existing)
			for (const [projectId, m] of Object.entries(memberships)) {
				saveMembership(projectId, m.bundle, m.projectName, m.role);
			}
			importSuccess = true;
		} catch (err) {
			importError = err instanceof Error ? err.message : m.link_import_failed();
		} finally {
			importing = false;
		}
	}
</script>

<svelte:head><title>Witness – {m.link_device_title()}</title></svelte:head>

<div class="mx-auto max-w-lg p-6 flex flex-col gap-6">
	<div>
		<a href="/dashboard" class="text-sm text-base-content/50 hover:text-base-content mb-2 inline-block">{m.back_dashboard()}</a>
		<h1 class="text-2xl font-bold">{m.link_device_title()}</h1>
	</div>

	{#if mode === 'loading'}
		<div class="flex justify-center"><span class="loading loading-spinner loading-lg"></span></div>

	{:else if mode === 'nokeys'}
		<div role="alert" class="alert alert-warning">
			<span>{m.link_device_no_keys()}</span>
		</div>

	{:else}
		<div role="tablist" class="tabs tabs-bordered">
			<button role="tab" class="tab {activeTab === 'link' ? 'tab-active' : ''}" onclick={() => activeTab = 'link'}>{m.link_tab_link()}</button>
			<button role="tab" class="tab {activeTab === 'export' ? 'tab-active' : ''}" onclick={() => activeTab = 'export'}>{m.link_tab_export()}</button>
			<button role="tab" class="tab {activeTab === 'import' ? 'tab-active' : ''}" onclick={() => activeTab = 'import'}>{m.link_tab_import()}</button>
		</div>

		{#if activeTab === 'link'}
			<p class="text-base-content/60 text-sm">{m.link_description()}</p>

			{#if linkStep === 'form'}
				<form class="flex flex-col gap-4" onsubmit={handleGenerateLink}>
					<label class="flex flex-col gap-1">
						<span class="label-text font-medium">{m.link_passphrase_label()}</span>
						<input type="password" class="input input-bordered" placeholder={m.link_passphrase_placeholder()} bind:value={linkPassphrase} required minlength={8} aria-label={m.link_passphrase_label()} />
					</label>
					<label class="flex flex-col gap-1">
						<span class="label-text font-medium">{m.link_confirm_passphrase_label()}</span>
						<input type="password" class="input input-bordered" bind:value={linkPassphraseConfirm} required aria-label={m.link_confirm_passphrase_label()} />
					</label>
					{#if linkError}<div role="alert" class="alert alert-error text-sm"><span>{linkError}</span></div>{/if}
					<button type="submit" class="btn btn-primary" disabled={generating} data-testid="generate-link-btn">
						{#if generating}<span class="loading loading-spinner loading-sm"></span>{/if}
						{m.link_generate_btn()}
					</button>
				</form>
			{:else}
				<div class="flex flex-col gap-4">
					<div role="status" class="alert alert-success text-sm"><span>{m.link_generated_success()}</span></div>
					<label class="flex flex-col gap-1">
						<span class="label-text text-sm font-medium">{m.link_import_link_label()}</span>
						<input type="text" readonly class="input input-bordered font-mono text-xs" value={importUrl} onclick={(e) => (e.target as HTMLInputElement).select()} aria-label={m.link_import_link_label()} data-testid="import-url" />
					</label>
					<div class="flex justify-center"><QrCode value={importUrl} /></div>
					<p class="text-xs text-base-content/50 text-center">{m.link_keep_secret()}</p>
					<button class="btn btn-ghost btn-sm" onclick={() => { linkStep = 'form'; linkPassphrase = ''; linkPassphraseConfirm = ''; }}>{m.link_generate_new()}</button>
				</div>
			{/if}

		{:else if activeTab === 'export'}
			<p class="text-base-content/60 text-sm">{m.link_export_description()}</p>
			<form class="flex flex-col gap-4" onsubmit={handleExport}>
				<label class="flex flex-col gap-1">
					<span class="label-text font-medium">{m.link_passphrase_label()}</span>
					<input type="password" class="input input-bordered" placeholder={m.link_passphrase_placeholder()} bind:value={exportPassphrase} required minlength={8} aria-label={m.link_passphrase_label()} />
				</label>
				<label class="flex flex-col gap-1">
					<span class="label-text font-medium">{m.link_confirm_passphrase_label()}</span>
					<input type="password" class="input input-bordered" bind:value={exportPassphraseConfirm} required aria-label={m.link_confirm_passphrase_label()} />
				</label>
				{#if exportError}<div role="alert" class="alert alert-error text-sm"><span>{exportError}</span></div>{/if}
				<button type="submit" class="btn btn-primary" disabled={exporting} data-testid="export-btn">
					{#if exporting}<span class="loading loading-spinner loading-sm"></span>{/if}
					{m.link_export_download_btn()}
				</button>
			</form>

		{:else if activeTab === 'import'}
			<p class="text-base-content/60 text-sm">{m.link_import_description()}</p>
			{#if importSuccess}
				<div role="status" class="alert alert-success">
					<span>{m.link_import_success()}</span>
					<a href="/dashboard" class="btn btn-sm btn-ghost ml-2">{m.link_go_dashboard()}</a>
				</div>
			{:else}
				<form class="flex flex-col gap-4" onsubmit={handleImport}>
					<label class="flex flex-col gap-1">
						<span class="label-text font-medium">{m.link_import_file_label()}</span>
						<input type="file" accept=".json,application/json" class="file-input file-input-bordered file-input-sm"
							onchange={(e) => importFile = (e.target as HTMLInputElement).files?.[0] ?? null}
							aria-label={m.link_import_file_label()} data-testid="import-file-input" />
					</label>
					<label class="flex flex-col gap-1">
						<span class="label-text font-medium">{m.link_import_passphrase_label()}</span>
						<input type="password" class="input input-bordered" bind:value={importPassphrase} required aria-label={m.link_import_passphrase_label()} data-testid="import-passphrase-input" />
					</label>
					{#if importError}<div role="alert" class="alert alert-error text-sm"><span>{importError}</span></div>{/if}
					<button type="submit" class="btn btn-primary" disabled={importing || !importFile} data-testid="import-file-btn">
						{#if importing}<span class="loading loading-spinner loading-sm"></span>{/if}
						{m.link_import_btn()}
					</button>
				</form>
			{/if}
		{/if}
	{/if}
</div>
