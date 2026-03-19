<script lang="ts">
	import { onMount } from 'svelte';
	import SubmissionForm from '$lib/components/SubmissionForm.svelte';
	import {
		generateSymmetricKey,
		encryptSymmetric,
		encryptSymmetricKeyFor,
		importEcdhPublicKey,
		importUserKeyBundleJwk,
		exportPublicKeyJwk,
		jwkToString,
		stringToJwk,
		sign
	} from '$lib/crypto';
	import { loadStoredKeys } from '$lib/client/key-store';
	import { api, ApiError } from '$lib/client/api';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type PageMode = 'loading' | 'form' | 'success' | 'error';
	let mode = $state<PageMode>('loading');
	let submitError = $state('');
	let submissionId = $state('');

	// Keys are loaded from localStorage on mount
	let userBundle: Awaited<ReturnType<typeof importUserKeyBundleJwk>> | null = null;
	let userEncryptionPublicKeyJwk: string = '';

	onMount(async () => {
		const stored = loadStoredKeys();
		if (!stored) {
			window.location.href = `/auth?next=/projects/${data.projectId}/submit`;
			return;
		}
		userBundle = await importUserKeyBundleJwk(stored);
		userEncryptionPublicKeyJwk = stored.encryptionPublicKey;
		mode = 'form';
	});

	async function handleSubmit(formData: Record<string, string>) {
		if (!userBundle) return;

		submitError = '';
		try {
			// 1. Generate a random symmetric key
			const symKey = await generateSymmetricKey();

			// 2. Encrypt the form payload
			const plaintext = new TextEncoder().encode(JSON.stringify(formData));
			const encryptedPayload = await encryptSymmetric(symKey, plaintext);

			// 3. Encrypt the symmetric key for the project and for ourselves
			const projectPublicKey = await importEcdhPublicKey(stringToJwk(data.projectPublicKey));
			const userEncPublicKey = await importEcdhPublicKey(stringToJwk(userEncryptionPublicKeyJwk));

			const [encKeyForProject, encKeyForUser] = await Promise.all([
				encryptSymmetricKeyFor(symKey, projectPublicKey),
				encryptSymmetricKeyFor(symKey, userEncPublicKey)
			]);

			// 4. Get a challenge nonce
			const { nonce } = await api.auth.challenge();

			// 5. Sign (nonce_bytes || SHA-256(encryptedPayload_bytes))
			const nonceBytes = new TextEncoder().encode(nonce);
			const payloadBytes = new TextEncoder().encode(encryptedPayload);
			const sha256bytes = new Uint8Array(
				await crypto.subtle.digest('SHA-256', payloadBytes)
			);
			const message = new Uint8Array(nonceBytes.length + sha256bytes.length);
			message.set(nonceBytes);
			message.set(sha256bytes, nonceBytes.length);

			const signingPubJwk = jwkToString(await exportPublicKeyJwk(userBundle!.signing.publicKey));
			void signingPubJwk; // used for reference; server looks up by session user
			const submitterSignature = await sign(userBundle!.signing.privateKey, message);

			// 6. Submit
			const response = await api.submissions.create({
				projectId: data.projectId,
				encryptedPayload,
				encryptedKeyProject: JSON.stringify(encKeyForProject),
				encryptedKeyUser: JSON.stringify(encKeyForUser),
				submitterSignature,
				nonce
			});

			submissionId = response.submissionId;
			mode = 'success';
		} catch (err) {
			submitError =
				err instanceof ApiError ? err.message : (err instanceof Error ? err.message : 'Submission failed');
		}
	}
</script>

<div>
	{#if mode === 'loading'}
		<div class="flex justify-center">
			<span class="loading loading-spinner loading-lg"></span>
		</div>

	{:else if mode === 'form'}
		<div class="mx-auto max-w-xl">
			{#if data.fields.length === 0}
				<p class="text-base-content/60">No fields have been configured for this project yet.</p>
			{:else}
				<SubmissionForm
					fields={data.fields}
					onsubmit={handleSubmit}
					error={submitError}
				/>
			{/if}
		</div>

	{:else if mode === 'success'}
		<div role="status" class="alert alert-success mx-auto max-w-xl">
			<span>Your submission was received.</span>
			<span class="text-xs font-mono opacity-60">ID: {submissionId}</span>
		</div>

	{:else if mode === 'error'}
		<div role="alert" class="alert alert-error mx-auto max-w-xl">
			<span>{submitError}</span>
		</div>
	{/if}
</div>
