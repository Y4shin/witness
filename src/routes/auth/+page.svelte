<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import RegistrationForm from '$lib/components/RegistrationForm.svelte';
	import {
		generateUserKeyBundle,
		exportUserKeyBundleJwk,
		importUserKeyBundleJwk,
		exportPublicKeyJwk,
		jwkToString,
		stringToJwk,
		importEcdhPublicKey,
		encryptSymmetric,
		generateSymmetricKey,
		encryptSymmetricKeyFor,
		sign
	} from '$lib/crypto';
	import { loadStoredKeys, saveKeys, clearKeys } from '$lib/client/key-store';
	import { api, ApiError } from '$lib/client/api';

	type Mode = 'loading' | 'register' | 'submitting' | 'login' | 'error';

	let mode = $state<Mode>('loading');
	let formError = $state('');
	let statusMessage = $state('');

	const projectId = $derived(page.url.searchParams.get('projectId'));

	// ── auth helpers ───────────────────────────────────────────────────────────

	async function challengeResponse(signingPrivateKey: CryptoKey, signingPublicKeyJwk: string): Promise<void> {
		const { nonce } = await api.auth.challenge();
		const signature = await sign(signingPrivateKey, new TextEncoder().encode(nonce));
		await api.auth.verify({ signingPublicKey: signingPublicKeyJwk, nonce, signature });
	}

	// ── login (returning user) ─────────────────────────────────────────────────

	async function performLogin(): Promise<void> {
		mode = 'login';
		statusMessage = 'Authenticating…';
		try {
			const stored = loadStoredKeys();
			if (!stored) { mode = 'register'; return; }

			const bundle = await importUserKeyBundleJwk(stored);
			const spkJwk = jwkToString(await exportPublicKeyJwk(bundle.signing.publicKey));
			await challengeResponse(bundle.signing.privateKey, spkJwk);
			await goto('/dashboard');
		} catch (err) {
			formError = err instanceof ApiError ? err.message : 'Login failed';
			mode = 'error';
		}
	}

	// ── registration (first-time user) ────────────────────────────────────────

	async function handleRegister(data: { name: string; contact: string }): Promise<void> {
		if (!projectId) {
			formError = 'Missing project context. Please use an invite link.';
			return;
		}

		mode = 'submitting';
		formError = '';

		try {
			statusMessage = 'Generating keys…';
			const bundle = await generateUserKeyBundle();

			statusMessage = 'Fetching project public key…';
			const { publicKey: projectPubKeyStr } = await api.projects.getPublicKey(projectId);
			const projectPublicKey = await importEcdhPublicKey(stringToJwk(projectPubKeyStr));

			statusMessage = 'Encrypting your data…';
			const [nameKey, contactKey] = await Promise.all([
				generateSymmetricKey(),
				generateSymmetricKey()
			]);
			const [encryptedNamePayload, encryptedContactPayload] = await Promise.all([
				encryptSymmetric(nameKey, new TextEncoder().encode(data.name)),
				encryptSymmetric(contactKey, new TextEncoder().encode(data.contact))
			]);
			const [encryptedNameKey, encryptedContactKey] = await Promise.all([
				encryptSymmetricKeyFor(nameKey, projectPublicKey),
				encryptSymmetricKeyFor(contactKey, projectPublicKey)
			]);
			const encryptedName = JSON.stringify({ payload: encryptedNamePayload, key: encryptedNameKey });
			const encryptedContact = JSON.stringify({ payload: encryptedContactPayload, key: encryptedContactKey });

			statusMessage = 'Registering…';
			const jwks = await exportUserKeyBundleJwk(bundle);
			await api.users.register({
				signingPublicKey: jwkToString(jwks.signingPublicKey),
				encryptionPublicKey: jwkToString(jwks.encryptionPublicKey),
				encryptedName,
				encryptedContact
			});

			statusMessage = 'Authenticating…';
			const spkJwk = jwkToString(jwks.signingPublicKey);
			await challengeResponse(bundle.signing.privateKey, spkJwk);

			// Persist keys only after full success
			saveKeys(jwks);
			await goto('/dashboard');
		} catch (err) {
			formError = err instanceof ApiError ? err.message : 'Registration failed';
			mode = 'register';
		}
	}

	function handleStartOver(): void {
		clearKeys();
		formError = '';
		mode = 'register';
	}

	// ── lifecycle ───────────────────────────────────────────────────────────────

	onMount(async () => {
		if (loadStoredKeys()) {
			await performLogin();
		} else {
			mode = 'register';
		}
	});
</script>

<div class="min-h-screen flex items-center justify-center p-4">
	<div class="card bg-base-100 shadow-xl w-full max-w-md">
		<div class="card-body">
			{#if mode === 'loading'}
				<div class="flex justify-center">
					<span class="loading loading-spinner loading-lg"></span>
				</div>

			{:else if mode === 'register'}
				<h1 class="card-title text-2xl mb-4">Create account</h1>
				{#if !projectId}
					<div role="alert" class="alert alert-warning">
						<span>No project context found. Please use a valid invite link.</span>
					</div>
				{:else}
					<RegistrationForm onsubmit={handleRegister} error={formError} />
				{/if}

			{:else if mode === 'submitting' || mode === 'login'}
				<div class="flex flex-col items-center gap-4">
					<span class="loading loading-spinner loading-lg"></span>
					<p class="text-base-content/70">{statusMessage}</p>
				</div>

			{:else if mode === 'error'}
				<div class="flex flex-col gap-4">
					<div role="alert" class="alert alert-error">
						<span>{formError}</span>
					</div>
					<button class="btn btn-outline" onclick={handleStartOver}>Start over</button>
				</div>
			{/if}
		</div>
	</div>
</div>
