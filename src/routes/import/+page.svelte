<script lang="ts">
	import { onMount } from 'svelte';
	import { deriveKeyFromPassphrase, decryptSymmetric, decode } from '$lib/crypto';
	import { saveMembership } from '$lib/client/key-store';
	import type { StoredMembership } from '$lib/client/key-store';
	import * as m from '$lib/paraglide/messages';

	export const ssr = false;

	type PageMode = 'loading' | 'prompt' | 'success' | 'error' | 'incomplete';
	let mode = $state<PageMode>('loading');
	let passphrase = $state('');
	let formError = $state('');
	let importing = $state(false);

	// Parsed from the fragment on mount
	let fragmentData: { v: number; salt: string; encrypted: string } | null = null;

	onMount(() => {
		const hash = window.location.hash.slice(1); // strip leading '#'
		if (!hash) {
			mode = 'incomplete';
			return;
		}
		try {
			const json = atob(hash.replace(/-/g, '+').replace(/_/g, '/'));
			fragmentData = JSON.parse(json) as { v: number; salt: string; encrypted: string };
			if (!fragmentData.v || !fragmentData.salt || !fragmentData.encrypted) {
				mode = 'incomplete';
				return;
			}
			mode = 'prompt';
		} catch {
			mode = 'incomplete';
		}
	});

	async function handleImport(e: SubmitEvent) {
		e.preventDefault();
		if (!fragmentData) return;
		formError = '';
		importing = true;

		try {
			if (fragmentData.v === 1) {
				formError = m.import_legacy_backup();
				return;
			}

			// Decode stored salt back to Uint8Array
			const saltBytes = decode(fragmentData.salt);
			const { key } = await deriveKeyFromPassphrase(passphrase, { salt: saltBytes });

			let memberships: Record<string, StoredMembership>;
			try {
				const plaintext = await decryptSymmetric(key, fragmentData.encrypted);
				memberships = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, StoredMembership>;
			} catch {
				formError = m.import_wrong_passphrase();
				return;
			}

			// Merge imported memberships (don't overwrite existing entries)
			for (const [projectId, mem] of Object.entries(memberships)) {
				saveMembership(projectId, mem.bundle, mem.projectName, mem.role);
			}

			mode = 'success';
		} catch (err) {
			formError = err instanceof Error ? err.message : m.import_failed();
		} finally {
			importing = false;
		}
	}
</script>

<svelte:head><title>Witness – {m.import_title()}</title></svelte:head>

<div class="mx-auto max-w-sm p-6 flex flex-col gap-6">
	<h1 class="text-2xl font-bold">{m.import_title()}</h1>

	{#if mode === 'loading'}
		<div class="flex justify-center"><span class="loading loading-spinner loading-lg"></span></div>

	{:else if mode === 'incomplete'}
		<div role="alert" class="alert alert-error">
			<span>{m.import_incomplete()}</span>
		</div>

	{:else if mode === 'prompt'}
		<p class="text-base-content/60 text-sm">{m.import_enter_passphrase()}</p>
		<form class="flex flex-col gap-4" onsubmit={handleImport}>
			<label class="flex flex-col gap-1">
				<span class="label-text font-medium">{m.import_passphrase_label()}</span>
				<input
					type="password"
					class="input input-bordered"
					placeholder={m.import_passphrase_placeholder()}
					bind:value={passphrase}
					required
					aria-label={m.import_passphrase_label()}
					data-testid="passphrase-input"
				/>
			</label>

			{#if formError}
				<div role="alert" class="alert alert-error text-sm"><span>{formError}</span></div>
			{/if}

			<button type="submit" class="btn btn-primary" disabled={importing} data-testid="import-btn">
				{#if importing}<span class="loading loading-spinner loading-sm"></span>{/if}
				{m.import_btn()}
			</button>
		</form>

	{:else if mode === 'success'}
		<div role="status" class="alert alert-success">
			<span>{m.import_success()}</span>
		</div>
		<a href="/dashboard" class="btn btn-primary">{m.import_go_dashboard()}</a>

	{:else if mode === 'error'}
		<div role="alert" class="alert alert-error">
			<span>{formError}</span>
		</div>
	{/if}
</div>
