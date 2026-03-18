<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import RegistrationForm from '$lib/components/RegistrationForm.svelte';
	import {
		generateUserKeyBundle,
		generateProjectKeyPair,
		exportUserKeyBundleJwk,
		importUserKeyBundleJwk,
		exportPublicKeyJwk,
		exportPrivateKeyPkcs8,
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
	type Role = 'SUBMITTER' | 'OBSERVER';

	let mode = $state<Mode>('loading');
	let formError = $state('');
	let statusMessage = $state('');

	const projectId = $derived(page.url.searchParams.get('projectId'));
	const inviteToken = $derived(page.url.searchParams.get('inviteToken'));
	const role = $derived(page.url.searchParams.get('role') as Role | null);

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
		if (!projectId || !inviteToken || !role) {
			formError = 'Missing project context. Please use an invite link.';
			return;
		}

		mode = 'submitting';
		formError = '';

		try {
			statusMessage = 'Generating keys…';
			const bundle = await generateUserKeyBundle();
			const jwks = await exportUserKeyBundleJwk(bundle);

			// ── Determine if this is the first observer (project has no key yet) ──
			let projectPublicKey: CryptoKey;
			let encryptedProjectPrivateKey: string | null = null;
			// Held for upload after authentication (PATCH requires an active session)
			let pendingProjectPublicKeyJwk: string | null = null;

			if (role === 'OBSERVER') {
				let existingKeyStr: string | null = null;
				try {
					const resp = await api.projects.getPublicKey(projectId);
					existingKeyStr = resp.publicKey;
				} catch (err) {
					if (!(err instanceof ApiError && err.status === 404)) throw err;
					// 404 means no key yet — this is the first observer
				}

				if (existingKeyStr) {
					// Subsequent observer: project key already exists
					projectPublicKey = await importEcdhPublicKey(stringToJwk(existingKeyStr));
				} else {
					// First observer: generate the project keypair
					statusMessage = 'Generating project keys…';
					const projectKeyPair = await generateProjectKeyPair();
					const projectPubJwk = await exportPublicKeyJwk(projectKeyPair.publicKey);
					projectPublicKey = projectKeyPair.publicKey;
					pendingProjectPublicKeyJwk = jwkToString(projectPubJwk);

					// Encrypt the project private key for storage in our own membership
					const pkcs8 = await exportPrivateKeyPkcs8(projectKeyPair.privateKey);
					const symKey = await generateSymmetricKey();
					const [encryptedPayload, encryptedSymKey] = await Promise.all([
						encryptSymmetric(symKey, pkcs8),
						encryptSymmetricKeyFor(
							symKey,
							await importEcdhPublicKey(jwks.encryptionPublicKey)
						)
					]);
					encryptedProjectPrivateKey = JSON.stringify({
						payload: encryptedPayload,
						key: encryptedSymKey
					});
				}
			} else {
				// Submitter: project must already have a public key
				statusMessage = 'Fetching project public key…';
				let keyStr: string;
				try {
					const resp = await api.projects.getPublicKey(projectId);
					keyStr = resp.publicKey;
				} catch (err) {
					if (err instanceof ApiError && err.status === 404) {
						throw new Error('This project is not ready yet. Please contact the project admin.');
					}
					throw err;
				}
				projectPublicKey = await importEcdhPublicKey(stringToJwk(keyStr));
			}

			// ── Encrypt name + contact with project public key ─────────────────
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

			// ── Create user account ────────────────────────────────────────────
			statusMessage = 'Registering…';
			await api.users.register({
				signingPublicKey: jwkToString(jwks.signingPublicKey),
				encryptionPublicKey: jwkToString(jwks.encryptionPublicKey),
				encryptedName,
				encryptedContact
			});

			// ── Authenticate (get session cookie) ──────────────────────────────
			statusMessage = 'Authenticating…';
			await challengeResponse(bundle.signing.privateKey, jwkToString(jwks.signingPublicKey));

			// ── Upload project public key now that we are authenticated ─────────
			if (pendingProjectPublicKeyJwk) {
				statusMessage = 'Uploading project key…';
				await api.projects.setPublicKey(projectId, { publicKey: pendingProjectPublicKeyJwk });
			}

			// ── Create membership (validates + consumes invite token) ──────────
			statusMessage = 'Joining project…';
			await api.memberships.join({ inviteToken, encryptedProjectPrivateKey });

			// Persist keys only after the full flow succeeds
			saveKeys(jwks);
			await goto('/dashboard');
		} catch (err) {
			formError = err instanceof ApiError ? err.message : (err instanceof Error ? err.message : 'Registration failed');
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
				{#if !projectId || !inviteToken}
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
