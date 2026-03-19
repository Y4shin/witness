<script lang="ts">
	import { onMount } from 'svelte';
	import { deriveKeyFromPassphrase, encryptSymmetric } from '$lib/crypto';
	import { loadStoredKeys } from '$lib/client/key-store';
	import QrCode from '$lib/components/QrCode.svelte';

	export const ssr = false;

	type PageMode = 'loading' | 'form' | 'generated' | 'nokeys';
	let mode = $state<PageMode>('loading');
	let passphrase = $state('');
	let passphraseConfirm = $state('');
	let formError = $state('');
	let generating = $state(false);
	let importUrl = $state('');

	onMount(() => {
		const stored = loadStoredKeys();
		if (!stored) {
			mode = 'nokeys';
			return;
		}
		mode = 'form';
	});

	async function handleGenerate(e: SubmitEvent) {
		e.preventDefault();
		formError = '';

		if (passphrase.length < 8) {
			formError = 'Passphrase must be at least 8 characters';
			return;
		}
		if (passphrase !== passphraseConfirm) {
			formError = 'Passphrases do not match';
			return;
		}

		generating = true;
		try {
			const stored = loadStoredKeys();
			if (!stored) { formError = 'No keys found'; return; }

			const { key, saltB64 } = await deriveKeyFromPassphrase(passphrase);
			const plaintext = new TextEncoder().encode(JSON.stringify(stored));
			const encrypted = await encryptSymmetric(key, plaintext);

			const fragment = btoa(JSON.stringify({ v: 1, salt: saltB64, encrypted }))
				.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

			importUrl = `${window.location.origin}/import#${fragment}`;
			mode = 'generated';
		} catch {
			formError = 'Failed to generate link';
		} finally {
			generating = false;
		}
	}
</script>

<svelte:head><title>Link another device</title></svelte:head>

<div class="mx-auto max-w-lg p-6 flex flex-col gap-6">
	<div>
		<a href="/dashboard" class="text-sm text-base-content/50 hover:text-base-content mb-2 inline-block">← Dashboard</a>
		<h1 class="text-2xl font-bold">Link another device</h1>
		<p class="text-base-content/60 text-sm mt-1">
			Generate a one-time link to securely transfer your keys to another device.
			The link encrypts your keys with a passphrase — enter the same passphrase on the other device.
		</p>
	</div>

	{#if mode === 'loading'}
		<div class="flex justify-center"><span class="loading loading-spinner loading-lg"></span></div>

	{:else if mode === 'nokeys'}
		<div role="alert" class="alert alert-warning">
			<span>No keys found. Please register or log in first.</span>
		</div>

	{:else if mode === 'form'}
		<form class="flex flex-col gap-4" onsubmit={handleGenerate}>
			<label class="flex flex-col gap-1">
				<span class="label-text font-medium">Passphrase</span>
				<input
					type="password"
					class="input input-bordered"
					placeholder="At least 8 characters"
					bind:value={passphrase}
					required
					minlength={8}
					aria-label="Passphrase"
				/>
			</label>
			<label class="flex flex-col gap-1">
				<span class="label-text font-medium">Confirm passphrase</span>
				<input
					type="password"
					class="input input-bordered"
					placeholder="Repeat passphrase"
					bind:value={passphraseConfirm}
					required
					aria-label="Confirm passphrase"
				/>
			</label>

			{#if formError}
				<div role="alert" class="alert alert-error text-sm"><span>{formError}</span></div>
			{/if}

			<button type="submit" class="btn btn-primary" disabled={generating} data-testid="generate-link-btn">
				{#if generating}<span class="loading loading-spinner loading-sm"></span>{/if}
				Generate link
			</button>
		</form>

	{:else if mode === 'generated'}
		<div class="flex flex-col gap-4">
			<div role="status" class="alert alert-success text-sm">
				<span>Link generated! Open it on your other device and enter the passphrase.</span>
			</div>

			<label class="flex flex-col gap-1">
				<span class="label-text text-sm font-medium">Import link</span>
				<input
					type="text"
					readonly
					class="input input-bordered font-mono text-xs"
					value={importUrl}
					onclick={(e) => (e.target as HTMLInputElement).select()}
					aria-label="Import link URL"
					data-testid="import-url"
				/>
			</label>

			<div class="flex justify-center">
				<QrCode value={importUrl} />
			</div>

			<p class="text-xs text-base-content/50 text-center">
				This link contains your encrypted keys. Keep the passphrase secret and do not share the link publicly.
			</p>

			<button class="btn btn-ghost btn-sm" onclick={() => { mode = 'form'; passphrase = ''; passphraseConfirm = ''; }}>
				Generate a new link
			</button>
		</div>
	{/if}
</div>
