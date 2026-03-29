<script lang="ts">
	import { onMount } from 'svelte';
	import TypedSubmissionForm from '$lib/components/TypedSubmissionForm.svelte';
	import PrivacyInfoModal from '$lib/components/PrivacyInfoModal.svelte';
	import {
		generateSymmetricKey,
		encryptSymmetric,
		encryptSymmetricKeyFor,
		importEcdhPublicKey,
		importUserKeyBundleJwk,
		jwkToString,
		exportPublicKeyJwk,
		stringToJwk,
		sign
	} from '$lib/crypto';
	import { loadMembershipForProject } from '$lib/client/key-store';
	import { api, ApiError } from '$lib/client/api';
	import { enqueue } from '$lib/client/queue';
	import type { SubmissionType, DecryptedPayload } from '$lib/api-types';
	import type { PageData } from './$types';
	import * as m from '$lib/paraglide/messages';

	let { data }: { data: PageData } = $props();

	type PageMode = 'loading' | 'form' | 'uploading' | 'success' | 'queued' | 'error';
	let mode = $state<PageMode>('loading');
	let submitError = $state('');
	let submissionId = $state('');
	let uploadProgress = $state('');
	let privacyOpen = $state(false);

	let userBundle: Awaited<ReturnType<typeof importUserKeyBundleJwk>> | null = null;
	let userEncryptionPublicKeyJwk: string = '';

	onMount(async () => {
		const membership = loadMembershipForProject(data.projectId);
		if (!membership) {
			window.location.href = `/auth?projectId=${data.projectId}&next=/projects/${data.projectId}/submit`;
			return;
		}
		const stored = membership.bundle;
		userBundle = await importUserKeyBundleJwk(stored);
		userEncryptionPublicKeyJwk = JSON.stringify(stored.encryptionPublicKey);
		mode = 'form';
	});

	async function handleSubmit(formData: {
		type: SubmissionType;
		fields: Record<string, string>;
		archiveCandidateUrl: string | null;
		files: File[];
	}) {
		if (!userBundle) return;

		submitError = '';
		try {
			// 1. Generate a random symmetric key
			const symKey = await generateSymmetricKey();

			// 2. Build the DecryptedPayload envelope.
			//    Archive URL is obtained via the server proxy (online only; null when offline).
			const archiveCandidateUrl = formData.archiveCandidateUrl ?? null;
			let archiveUrl: string | null = null;
			if (navigator.onLine && archiveCandidateUrl) {
				try {
					const result = await api.archive.proxy({ url: archiveCandidateUrl });
					archiveUrl = result.archiveUrl;
				} catch {
					// Archive failure is non-fatal — submission proceeds without archive URL
				}
			}

			const payload: DecryptedPayload = {
				type: formData.type,
				archiveCandidateUrl,
				archiveUrl,
				fields: formData.fields
			};

			// 3. Encrypt the payload
			const plaintext = new TextEncoder().encode(JSON.stringify(payload));
			const encryptedPayload = await encryptSymmetric(symKey, plaintext);

			// 4. Encrypt the symmetric key for the project and for ourselves
			const projectPublicKey = await importEcdhPublicKey(stringToJwk(data.projectPublicKey));
			const userEncPublicKey = await importEcdhPublicKey(stringToJwk(userEncryptionPublicKeyJwk));

			const [encKeyForProject, encKeyForUser] = await Promise.all([
				encryptSymmetricKeyFor(symKey, projectPublicKey),
				encryptSymmetricKeyFor(symKey, userEncPublicKey)
			]);

			// 5. Encrypt files (needed for both online and offline paths)
			const pendingFiles = [];
			for (const file of formData.files) {
				const fileBytes = new Uint8Array(await file.arrayBuffer());
				const fileSymKey = await generateSymmetricKey();
				const encryptedDataStr = await encryptSymmetric(fileSymKey, fileBytes);
				const metaBytes = new TextEncoder().encode(
					JSON.stringify({ mimeType: file.type || 'application/octet-stream' })
				);
				const encryptedMetaStr = await encryptSymmetric(fileSymKey, metaBytes);
				const [encFileKeyForProject, encFileKeyForUser] = await Promise.all([
					encryptSymmetricKeyFor(fileSymKey, projectPublicKey),
					encryptSymmetricKeyFor(fileSymKey, userEncPublicKey)
				]);
				pendingFiles.push({
					fieldName: 'evidence',
					encryptedMeta: encryptedMetaStr,
					encryptedData: encryptedDataStr,
					encryptedKey: JSON.stringify(encFileKeyForProject),
					encryptedKeyUser: JSON.stringify(encFileKeyForUser)
				});
			}

			// Branch: offline → enqueue; online → submit immediately
			if (!navigator.onLine) {
				await enqueue({
					projectId: data.projectId,
					encryptedPayload,
					encryptedKeyProject: JSON.stringify(encKeyForProject),
					encryptedKeyUser: JSON.stringify(encKeyForUser),
					files: pendingFiles
				});
				mode = 'queued';
				return;
			}

			// 6. Get a challenge nonce and sign
			const { nonce } = await api.auth.challenge();

			const nonceBytes = new TextEncoder().encode(nonce);
			const payloadBytes = new TextEncoder().encode(encryptedPayload);
			const sha256bytes = new Uint8Array(
				await crypto.subtle.digest('SHA-256', payloadBytes)
			);
			const message = new Uint8Array(nonceBytes.length + sha256bytes.length);
			message.set(nonceBytes);
			message.set(sha256bytes, nonceBytes.length);

			void jwkToString(await exportPublicKeyJwk(userBundle!.signing.publicKey));
			const submitterSignature = await sign(userBundle!.signing.privateKey, message);

			// 7. Submit
			const response = await api.submissions.create({
				projectId: data.projectId,
				encryptedPayload,
				encryptedKeyProject: JSON.stringify(encKeyForProject),
				encryptedKeyUser: JSON.stringify(encKeyForUser),
				submitterSignature,
				nonce
			});

			submissionId = response.submissionId;

			// 6. Upload files if any
			if (pendingFiles.length > 0) {
				mode = 'uploading';
				for (let i = 0; i < pendingFiles.length; i++) {
					uploadProgress = m.submit_uploading_file() + ' ' + (i + 1) + ' of ' + pendingFiles.length + '…';
					await api.submissions.uploadFile(submissionId, pendingFiles[i]);
				}
			}

			mode = 'success';
		} catch (err) {
			submitError =
				err instanceof ApiError ? err.message : (err instanceof Error ? err.message : 'Submission failed');
			mode = 'form';
		}
	}
</script>

<svelte:head><title>Witness – Submit</title></svelte:head>

<PrivacyInfoModal open={privacyOpen} onclose={() => (privacyOpen = false)} />

<div>
	{#if mode === 'loading'}
		<div class="flex justify-center">
			<span class="loading loading-spinner loading-lg"></span>
		</div>

	{:else if mode === 'form'}
		<div class="mx-auto max-w-xl">
			<div class="flex justify-end mb-2">
				<button class="btn btn-ghost btn-xs" onclick={() => (privacyOpen = true)}>
					{m.privacy_help_btn()}
				</button>
			</div>
			<TypedSubmissionForm formFields={data.formFields} onsubmit={handleSubmit} error={submitError} />
		</div>

	{:else if mode === 'uploading'}
		<div class="flex flex-col items-center gap-3 mx-auto max-w-xl">
			<span class="loading loading-spinner loading-lg"></span>
			<p class="text-sm text-base-content/60">{uploadProgress}</p>
		</div>

	{:else if mode === 'success'}
		<div role="status" class="alert alert-success mx-auto max-w-xl">
			<span>{m.submit_success()}</span>
			<span class="text-xs font-mono opacity-60">ID: {submissionId}</span>
		</div>

	{:else if mode === 'queued'}
		<div role="status" class="alert alert-warning mx-auto max-w-xl">
			<span>{m.submit_queued()}</span>
		</div>

	{:else if mode === 'error'}
		<div role="alert" class="alert alert-error mx-auto max-w-xl">
			<span>{submitError}</span>
		</div>
	{/if}
</div>
