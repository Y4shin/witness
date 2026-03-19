<script lang="ts">
	import { onMount } from 'svelte';
	import {
		deriveKeyFromPassphrase,
		decryptSymmetric,
		decode,
		importUserKeyBundleJwk,
		jwkToString,
		exportPublicKeyJwk,
		sign
	} from '$lib/crypto';
	import { saveKeys } from '$lib/client/key-store';
	import { api, ApiError } from '$lib/client/api';
	import type { UserKeyBundleJwk } from '$lib/crypto/keys';
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
			// Decode stored salt back to Uint8Array
			const saltBytes = decode(fragmentData.salt);
			const { key } = await deriveKeyFromPassphrase(passphrase, { salt: saltBytes });

			let keyBundleJwk: UserKeyBundleJwk;
			try {
				const plaintext = await decryptSymmetric(key, fragmentData.encrypted);
				keyBundleJwk = JSON.parse(new TextDecoder().decode(plaintext)) as UserKeyBundleJwk;
			} catch {
				formError = 'Wrong passphrase — decryption failed';
				return;
			}

			// Validate the bundle by importing it
			const userBundle = await importUserKeyBundleJwk(keyBundleJwk);

			// Save to localStorage
			saveKeys(keyBundleJwk);

			// Authenticate with the server
			const signingPublicKey = jwkToString(await exportPublicKeyJwk(userBundle.signing.publicKey));
			const { nonce } = await api.auth.challenge();
			const nonceBytes = new TextEncoder().encode(nonce);
			const sigBytes = await sign(userBundle.signing.privateKey, nonceBytes);
			await api.auth.verify({ signingPublicKey, nonce, signature: sigBytes });

			mode = 'success';
			setTimeout(() => { window.location.href = '/dashboard'; }, 1500);
		} catch (err) {
			formError = err instanceof ApiError ? err.message : (err instanceof Error ? err.message : 'Import failed');
		} finally {
			importing = false;
		}
	}
</script>

<svelte:head><title>{m.import_title()}</title></svelte:head>

<div class="mx-auto max-w-sm p-6 flex flex-col gap-6">
	<h1 class="text-2xl font-bold">{m.import_title()}</h1>

	{#if mode === 'loading'}
		<div class="flex justify-center"><span class="loading loading-spinner loading-lg"></span></div>

	{:else if mode === 'incomplete'}
		<div role="alert" class="alert alert-error">
			<span>{m.import_incomplete()}</span>
		</div>

	{:else if mode === 'prompt'}
		<p class="text-base-content/60 text-sm">Enter the passphrase used when the link was generated.</p>
		<form class="flex flex-col gap-4" onsubmit={handleImport}>
			<label class="flex flex-col gap-1">
				<span class="label-text font-medium">{m.import_passphrase_label()}</span>
				<input
					type="password"
					class="input input-bordered"
					placeholder="Enter passphrase"
					bind:value={passphrase}
					required
					aria-label="Passphrase"
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

	{:else if mode === 'error'}
		<div role="alert" class="alert alert-error">
			<span>{formError}</span>
		</div>
	{/if}
</div>
