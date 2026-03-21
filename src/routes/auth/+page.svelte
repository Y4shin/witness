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
	import {
		loadMembershipForProject,
		saveMembership,
		clearMembership
	} from '$lib/client/key-store';
	import { api, ApiError } from '$lib/client/api';
	import type { UserKeyBundleJwk } from '$lib/crypto/keys';
	import * as m from '$lib/paraglide/messages';

	type Mode = 'loading' | 'onboarding' | 'register' | 'submitting' | 'login' | 'nocontext' | 'error';
	type Role = 'SUBMITTER' | 'MODERATOR';

	let mode = $state<Mode>('loading');
	let formError = $state('');
	let statusMessage = $state('');

	const projectId = $derived(page.url.searchParams.get('projectId'));
	const inviteToken = $derived(page.url.searchParams.get('inviteToken'));
	const nextUrl = $derived(page.url.searchParams.get('next'));
	const role = $derived(page.url.searchParams.get('role') as Role | null);

	// ── auth helpers ───────────────────────────────────────────────────────────

	async function challengeResponse(signingPrivateKey: CryptoKey, signingPublicKeyJwk: string): Promise<void> {
		const { nonce } = await api.auth.challenge();
		const signature = await sign(signingPrivateKey, new TextEncoder().encode(nonce));
		await api.auth.verify({ signingPublicKey: signingPublicKeyJwk, nonce, signature });
	}

	// ── per-project login ──────────────────────────────────────────────────────

	async function performLoginForProject(pid: string, bundle: UserKeyBundleJwk): Promise<void> {
		mode = 'login';
		statusMessage = m.auth_status_authenticating();
		try {
			const keys = await importUserKeyBundleJwk(bundle);
			const spkJwk = jwkToString(await exportPublicKeyJwk(keys.signing.publicKey));
			await challengeResponse(keys.signing.privateKey, spkJwk);
			await goto(nextUrl ?? `/projects/${pid}`);
		} catch (err) {
			formError = err instanceof ApiError ? err.message : m.auth_login_failed();
			mode = 'error';
		}
	}

	// ── registration (first-time for this project) ─────────────────────────────

	async function handleRegister(data: { name: string; contact: string }): Promise<void> {
		if (!projectId || !inviteToken || !role) {
			formError = m.auth_missing_context();
			return;
		}

		mode = 'submitting';
		formError = '';

		try {
			statusMessage = m.auth_status_generating_keys();
			const bundle = await generateUserKeyBundle();
			const jwks = await exportUserKeyBundleJwk(bundle);

			// ── Determine project public key ──────────────────────────────────
			let projectPublicKey: CryptoKey;
			let encryptedProjectPrivateKey: string | null = null;
			let pendingProjectPublicKeyJwk: string | null = null;

			if (role === 'MODERATOR') {
				let existingKeyStr: string | null = null;
				try {
					const resp = await api.projects.getPublicKey(projectId);
					existingKeyStr = resp.publicKey;
				} catch (err) {
					if (!(err instanceof ApiError && err.status === 404)) throw err;
					// 404 means no key yet — this is the first MODERATOR
				}

				if (existingKeyStr) {
					projectPublicKey = await importEcdhPublicKey(stringToJwk(existingKeyStr));
				} else {
					// First MODERATOR: generate the project keypair
					statusMessage = m.auth_status_generating_project_keys();
					const projectKeyPair = await generateProjectKeyPair();
					const projectPubJwk = await exportPublicKeyJwk(projectKeyPair.publicKey);
					projectPublicKey = projectKeyPair.publicKey;
					pendingProjectPublicKeyJwk = jwkToString(projectPubJwk);

					// Encrypt project private key for storage in this member record
					const pkcs8 = await exportPrivateKeyPkcs8(projectKeyPair.privateKey);
					const symKey = await generateSymmetricKey();
					const [encryptedPayload, encryptedSymKey] = await Promise.all([
						encryptSymmetric(symKey, pkcs8),
						encryptSymmetricKeyFor(symKey, await importEcdhPublicKey(jwks.encryptionPublicKey))
					]);
					encryptedProjectPrivateKey = JSON.stringify({ payload: encryptedPayload, key: encryptedSymKey });
				}
			} else {
				// Submitter: project must already have a public key
				statusMessage = m.auth_status_fetching_project_key();
				try {
					const resp = await api.projects.getPublicKey(projectId);
					projectPublicKey = await importEcdhPublicKey(stringToJwk(resp.publicKey));
				} catch (err) {
					if (err instanceof ApiError && err.status === 404) {
						throw new Error(m.auth_project_not_ready());
					}
					throw err;
				}
			}

			// ── Encrypt name + contact with project public key ─────────────────
			statusMessage = m.auth_status_encrypting();
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

			// ── Join project (creates member, consumes invite) ─────────────────
			statusMessage = m.auth_status_joining();
			const joinResp = await api.memberships.join({
				inviteToken,
				signingPublicKey: jwkToString(jwks.signingPublicKey),
				encryptionPublicKey: jwkToString(jwks.encryptionPublicKey),
				encryptedName,
				encryptedContact,
				encryptedProjectPrivateKey
			});

			// ── Authenticate (get session cookie) ──────────────────────────────
			statusMessage = m.auth_status_authenticating();
			await challengeResponse(bundle.signing.privateKey, jwkToString(jwks.signingPublicKey));

			// ── Upload project public key now that we are authenticated ─────────
			if (pendingProjectPublicKeyJwk) {
				statusMessage = m.auth_status_uploading_key();
				await api.projects.setPublicKey(projectId, { publicKey: pendingProjectPublicKeyJwk });
			}

			// Persist membership only after the full flow succeeds
			saveMembership(joinResp.projectId, jwks, joinResp.projectName, joinResp.role);
			await goto(nextUrl ?? '/dashboard');
		} catch (err) {
			formError = err instanceof ApiError ? err.message : (err instanceof Error ? err.message : m.auth_registration_failed());
			mode = 'register';
		}
	}

	function handleStartOver(): void {
		if (projectId) clearMembership(projectId);
		formError = '';
		mode = 'register';
	}

	// ── lifecycle ───────────────────────────────────────────────────────────────

	onMount(async () => {
		if (!projectId) {
			mode = 'nocontext';
			return;
		}

		const stored = loadMembershipForProject(projectId);
		if (stored) {
			// Returning member: auto-login silently (invite not required)
			await performLoginForProject(projectId, stored.bundle);
		} else if (!inviteToken) {
			// No stored membership and no invite — nothing to do
			mode = 'nocontext';
		} else {
			// First-time registration: show privacy onboarding
			mode = 'onboarding';
		}
	});
</script>

<svelte:head><title>Witness – Sign in</title></svelte:head>

<div class="min-h-screen flex items-center justify-center p-4">
	<div class="card bg-base-100 shadow-xl w-full max-w-md">
		<div class="card-body">
			{#if mode === 'loading'}
				<div class="flex justify-center">
					<span class="loading loading-spinner loading-lg"></span>
				</div>

			{:else if mode === 'nocontext'}
				<div role="alert" class="alert alert-warning">
					<span>{m.auth_no_invite()}</span>
				</div>
				<a href="/" class="btn btn-outline mt-2">{m.auth_go_home()}</a>

			{:else if mode === 'onboarding'}
				<h1 class="card-title text-xl mb-4">{m.privacy_title()}</h1>
				<div class="flex flex-col gap-3 text-sm">
					<div>
						<p class="font-semibold mb-0.5">{m.privacy_e2e_heading()}</p>
						<p class="text-base-content/70">{m.privacy_e2e_body()}</p>
					</div>
					<div>
						<p class="font-semibold mb-0.5">{m.privacy_identity_heading()}</p>
						<p class="text-base-content/70">{m.privacy_identity_body()}</p>
					</div>
					<div>
						<p class="font-semibold mb-0.5">{m.privacy_key_heading()}</p>
						<p class="text-base-content/70">{m.privacy_key_body()}</p>
					</div>
					<div>
						<p class="font-semibold mb-0.5">{m.privacy_moderators_heading()}</p>
						<p class="text-base-content/70">{m.privacy_moderators_body()}</p>
					</div>
					<div>
						<p class="font-semibold mb-0.5">{m.privacy_backup_heading()}</p>
						<p class="text-base-content/70">{m.privacy_backup_body()}</p>
					</div>
				</div>
				<div class="card-actions mt-5">
					<button class="btn btn-primary w-full" onclick={() => (mode = 'register')}>
						{m.privacy_continue()}
					</button>
				</div>

			{:else if mode === 'register'}
				<h1 class="card-title text-2xl mb-4">{m.auth_register_title()}</h1>
				{#if !projectId || !inviteToken}
					<div role="alert" class="alert alert-warning">
						<span>{m.auth_no_project_context()}</span>
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
					<button class="btn btn-outline" onclick={handleStartOver}>{m.auth_start_over()}</button>
				</div>
			{/if}
		</div>
	</div>
</div>
