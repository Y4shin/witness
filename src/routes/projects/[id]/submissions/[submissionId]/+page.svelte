<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		decryptSymmetricKey,
		decryptSymmetric,
		importEcdhPrivateKey,
		importEcdhPublicKey,
		importUserKeyBundleJwk,
		generateSymmetricKey,
		encryptSymmetric,
		encryptSymmetricKeyFor,
		stringToJwk
	} from '$lib/crypto';
	import type { EncryptedKey } from '$lib/crypto/asymmetric';
	import { loadMembershipForProject } from '$lib/client/key-store';
	import { api, ApiError } from '$lib/client/api';
	import { SUBMISSION_TYPE_LABELS } from '$lib/submission-types';
	import type { FormField, DecryptedPayload, SubmissionType } from '$lib/api-types';
	import type { PageData } from './$types';
	import * as m from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';

	let { data }: { data: PageData } = $props();

	// ── Types ──────────────────────────────────────────────────────────────────

	type DecryptedField = { key: string; value: string };
	type FileState =
		| { kind: 'idle' }
		| { kind: 'loading' }
		| { kind: 'ready'; blobUrl: string; mimeType: string }
		| { kind: 'error'; message: string };

	type FileEntry = {
		id: string;
		fieldName: string;
		encryptedMeta: string | null; // AES-GCM ciphertext of { mimeType }; null for legacy files
		mimeType: string | null;      // populated lazily when file is decrypted
		sizeBytes: number;
		encryptedKey: string;
		preview: FileState;
	};

	type PageMode = 'loading' | 'ready' | 'error';

	// ── State ──────────────────────────────────────────────────────────────────

	let mode = $state<PageMode>('loading');
	let pageError = $state('');

	let subType = $state('');
	let subCreatedAt = $state('');
	let subArchiveUrl = $state<string | null>(null);
	let subFields = $state<DecryptedField[]>([]);
	let subDecryptError = $state('');
	let files = $state<FileEntry[]>([]);
	let formFields = $state<FormField[]>([]);

	let projectPrivateKey: CryptoKey | null = null;
	let userEncryptionPrivateKey: CryptoKey | null = null;

	// Blob URLs created during this session — revoked on destroy
	const blobUrls: string[] = [];

	// ── Mount ──────────────────────────────────────────────────────────────────

	onMount(async () => {
		const membership = loadMembershipForProject(data.projectId);
		if (!membership) {
			window.location.href = `/auth?projectId=${data.projectId}&next=/projects/${data.projectId}/submissions/${data.submissionId}`;
			return;
		}

		try {
			const userBundle = await importUserKeyBundleJwk(membership.bundle);
			userEncryptionPrivateKey = userBundle.encryption.privateKey;

			// Decrypt project private key (moderators only)
			if (data.role === 'MODERATOR' && data.encryptedProjectPrivateKey) {
				const encProjKey = JSON.parse(data.encryptedProjectPrivateKey) as {
					payload: string;
					key: EncryptedKey;
				};
				const symKey = await decryptSymmetricKey(encProjKey.key, userBundle.encryption.privateKey);
				const pkcs8 = await decryptSymmetric(symKey, encProjKey.payload);
				projectPrivateKey = await importEcdhPrivateKey(pkcs8);
			}

			// Fetch submission + file list + form fields in parallel
			const [submissionRes, filesRes, fieldsRes] = await Promise.all([
				fetch(`/api/submissions/${data.submissionId}`).then((r) => r.json() as Promise<{ submissions: import('$lib/api-types').SubmissionRecord[] }>),
				api.files.list(data.submissionId),
				api.fields.list(data.projectId).catch(() => ({ fields: [] as FormField[] }))
			]);

			formFields = fieldsRes.fields;

			const raw = submissionRes.submissions[0];
			if (!raw) throw new Error('Submission not found');

			subCreatedAt = raw.createdAt;

			// Decrypt submission payload — type and archiveUrl live inside the envelope
			try {
				let symKey: CryptoKey;
				if (data.role === 'MODERATOR' && projectPrivateKey) {
					const encKeyProject = JSON.parse(raw.encryptedKeyProject) as EncryptedKey;
					symKey = await decryptSymmetricKey(encKeyProject, projectPrivateKey);
				} else {
					const encKeyUser = JSON.parse(raw.encryptedKeyUser) as EncryptedKey;
					symKey = await decryptSymmetricKey(encKeyUser, userBundle.encryption.privateKey);
				}
				const plaintext = await decryptSymmetric(symKey, raw.encryptedPayload);
				const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as DecryptedPayload | Record<string, string>;

				// Support legacy submissions whose payload is a flat Record<string,string>
				const isEnvelope = (p: unknown): p is DecryptedPayload =>
					typeof p === 'object' && p !== null && 'fields' in p;

				const fields = isEnvelope(parsed) ? parsed.fields : (parsed as Record<string, string>);
				if (isEnvelope(parsed)) {
					subType = parsed.type ?? '';
					subArchiveUrl = parsed.archiveUrl;
				} else {
					// v1: read from plaintext columns
					subType = raw.type ?? '';
					subArchiveUrl = raw.archiveUrl;
				}
				subFields = Object.entries(fields).map(([key, value]) => ({ key, value }));

				// Background migration: re-encrypt with DecryptedPayload envelope if v1
				if (raw.schemaVersion === 1) {
					(async () => {
						try {
							const { publicKey: projPubKeyStr } = await api.projects.getPublicKey(data.projectId);
							const projectPublicKey = await importEcdhPublicKey(stringToJwk(projPubKeyStr));
							const userEncPublicKey = await importEcdhPublicKey(
								stringToJwk(JSON.stringify(membership.bundle.encryptionPublicKey))
							);
							const newSymKey = await generateSymmetricKey();
							const envelope: DecryptedPayload = {
								type: (raw.type ?? 'FILE_UPLOAD') as SubmissionType,
								archiveCandidateUrl: raw.archiveCandidateUrl,
								archiveUrl: raw.archiveUrl,
								fields
							};
							const encryptedPayload = await encryptSymmetric(
								newSymKey,
								new TextEncoder().encode(JSON.stringify(envelope))
							);
							const [encKeyProject, encKeyUser] = await Promise.all([
								encryptSymmetricKeyFor(newSymKey, projectPublicKey),
								encryptSymmetricKeyFor(newSymKey, userEncPublicKey)
							]);
							await api.submissions.migrate(raw.id, {
								encryptedPayload,
								encryptedKeyProject: JSON.stringify(encKeyProject),
								encryptedKeyUser: JSON.stringify(encKeyUser)
							});
						} catch {
							// Non-fatal — will retry on next load
						}
					})();
				}
			} catch {
				subDecryptError = 'Decryption failed — key may be missing or corrupted';
			}

			// Map file records — decrypt encryptedMeta eagerly to populate mimeType
			// (needed to show Preview buttons before any interaction)
			const decKey = data.role === 'MODERATOR' ? projectPrivateKey! : userBundle.encryption.privateKey;
			files = await Promise.all(
				filesRes.files.map(async (f) => {
					let mimeType: string | null = null;
					if (f.encryptedMeta) {
						// v2: decrypt encryptedMeta to recover mimeType
						try {
							const encKey = JSON.parse(f.encryptedKey) as EncryptedKey;
							const fileSymKey = await decryptSymmetricKey(encKey, decKey);
							const metaBytes = await decryptSymmetric(fileSymKey, f.encryptedMeta);
							const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as { mimeType: string };
							mimeType = meta.mimeType ?? null;
						} catch {
							// corrupted — leave null
						}
					} else if (f.schemaVersion === 1 && f.mimeType) {
						// v1: mimeType is in plaintext; use it directly and migrate in background
						mimeType = f.mimeType;
						try {
							const encKey = JSON.parse(f.encryptedKey) as EncryptedKey;
							const fileSymKey = await decryptSymmetricKey(encKey, decKey);
							const metaBytes = new TextEncoder().encode(JSON.stringify({ mimeType: f.mimeType }));
							const encryptedMeta = await encryptSymmetric(fileSymKey, metaBytes);
							api.files.migrate(data.submissionId, f.id, { encryptedMeta }).catch(() => {});
						} catch {
							// Non-fatal — will retry on next load
						}
					}
					return {
						id: f.id,
						fieldName: f.fieldName,
						encryptedMeta: f.encryptedMeta,
						mimeType,
						sizeBytes: f.sizeBytes,
						encryptedKey: f.encryptedKey,
						preview: { kind: 'idle' as const }
					};
				})
			);

			mode = 'ready';
		} catch (err) {
			pageError =
				err instanceof ApiError
					? err.message
					: err instanceof Error
						? err.message
						: 'Failed to load submission';
			mode = 'error';
		}
	});

	onDestroy(() => {
		for (const url of blobUrls) URL.revokeObjectURL(url);
	});

	// ── File actions ───────────────────────────────────────────────────────────

	async function loadFile(fileId: string) {
		const idx = files.findIndex((f) => f.id === fileId);
		if (idx === -1) return;

		const file = files[idx];
		if (file.preview.kind === 'ready') {
			// Toggle off
			URL.revokeObjectURL(file.preview.blobUrl);
			blobUrls.splice(blobUrls.indexOf(file.preview.blobUrl), 1);
			files[idx] = { ...file, preview: { kind: 'idle' } };
			return;
		}

		files[idx] = { ...file, preview: { kind: 'loading' } };

		try {
			const decryptionKey = data.role === 'MODERATOR' ? projectPrivateKey! : userEncryptionPrivateKey!;
			const encKey = JSON.parse(file.encryptedKey) as EncryptedKey;
			const symKey = await decryptSymmetricKey(encKey, decryptionKey);

			// Decrypt mimeType from encryptedMeta if not yet resolved
			let mime = file.mimeType;
			if (!mime && file.encryptedMeta) {
				try {
					const metaBytes = await decryptSymmetric(symKey, file.encryptedMeta);
					const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as { mimeType: string };
					mime = meta.mimeType ?? null;
					files[idx] = { ...files[idx], mimeType: mime };
				} catch {
					// corrupted meta — fall back
				}
			}
			mime ??= 'application/octet-stream';

			const { bytes: encBytes } = await api.files.downloadEncrypted(data.submissionId, fileId);
			const iv = encBytes.slice(0, 12);
			const ciphertext = encBytes.slice(12);
			const decrypted = new Uint8Array(
				await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, symKey, ciphertext)
			);

			const blob = new Blob([decrypted], { type: mime });
			const blobUrl = URL.createObjectURL(blob);
			blobUrls.push(blobUrl);
			files[idx] = { ...files[idx], preview: { kind: 'ready', blobUrl, mimeType: mime } };
		} catch (err) {
			files[idx] = {
				...file,
				preview: {
					kind: 'error',
					message: err instanceof Error ? err.message : 'Failed to load file'
				}
			};
		}
	}

	async function downloadFile(fileId: string) {
		const fileIdx = files.findIndex((f) => f.id === fileId);
		if (fileIdx === -1) return;
		const file = files[fileIdx];

		// If already loaded in preview, reuse the blob
		if (file.preview.kind === 'ready') {
			triggerDownload(file.preview.blobUrl, file.fieldName, file.preview.mimeType);
			return;
		}

		try {
			const decryptionKey = data.role === 'MODERATOR' ? projectPrivateKey! : userEncryptionPrivateKey!;
			const encKey = JSON.parse(file.encryptedKey) as EncryptedKey;
			const symKey = await decryptSymmetricKey(encKey, decryptionKey);

			// Decrypt mimeType from encryptedMeta if not yet resolved
			let mime = file.mimeType;
			if (!mime && file.encryptedMeta) {
				try {
					const metaBytes = await decryptSymmetric(symKey, file.encryptedMeta);
					const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as { mimeType: string };
					mime = meta.mimeType ?? null;
					files[fileIdx] = { ...files[fileIdx], mimeType: mime };
				} catch {
					// corrupted meta — fall back
				}
			}
			mime ??= 'application/octet-stream';

			const { bytes: encBytes } = await api.files.downloadEncrypted(data.submissionId, fileId);
			const iv = encBytes.slice(0, 12);
			const ciphertext = encBytes.slice(12);
			const decrypted = new Uint8Array(
				await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, symKey, ciphertext)
			);

			const blob = new Blob([decrypted], { type: mime });
			const url = URL.createObjectURL(blob);
			triggerDownload(url, file.fieldName, mime);
			URL.revokeObjectURL(url);
		} catch {
			// no-op; user can retry
		}
	}

	function triggerDownload(url: string, name: string, mime: string) {
		const ext = mime.split('/')[1]?.split(';')[0] ?? '';
		const filename = ext ? `${name}.${ext}` : name;
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
	}

	function isPreviewable(mime: string | null): boolean {
		if (!mime) return false;
		return mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/') || mime === 'application/pdf';
	}

	function formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleString();
	}
</script>

<svelte:head><title>Witness – Submission</title></svelte:head>

{#if mode === 'loading'}
	<div class="flex justify-center py-12">
		<span class="loading loading-spinner loading-lg"></span>
	</div>

{:else if mode === 'error'}
	<div role="alert" class="alert alert-error max-w-2xl">
		<span>{pageError}</span>
	</div>

{:else}
	<div class="max-w-2xl flex flex-col gap-6">

		<!-- ── Header ─────────────────────────────────────────────────────────── -->
		<div class="flex items-center gap-3 flex-wrap">
			<span class="badge badge-primary">{subType ? SUBMISSION_TYPE_LABELS[subType as import('$lib/api-types').SubmissionType] ?? subType : '(Unknown)'}</span>
			<span class="text-sm text-base-content/60">{formatDate(subCreatedAt)}</span>
			<span class="text-xs font-mono text-base-content/40">ID: {data.submissionId}</span>
		</div>

		{#if subArchiveUrl}
			<a href={localizeHref(subArchiveUrl!)} target="_blank" rel="noopener noreferrer" class="link link-primary text-sm">
				{m.submissions_archive_link()}
			</a>
		{/if}

		<!-- ── Form fields ─────────────────────────────────────────────────────── -->
		<div class="card bg-base-100 shadow">
			<div class="card-body">
				{#if subDecryptError}
					<div role="alert" class="alert alert-error text-sm">
						<span>{subDecryptError}</span>
					</div>
				{:else if subFields.length === 0}
					<p class="text-base-content/50 text-sm">{m.submission_details_no_fields()}</p>
				{:else}
					<dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
						{#each subFields as field (field.key)}
							<dt class="font-medium text-sm text-base-content/70 capitalize pt-0.5">
								{field.key.replace(/^custom_[^_]+_?/, '')}
							</dt>
							<dd class="text-sm break-all">{field.value}</dd>
						{/each}
					</dl>
				{/if}
			</div>
		</div>

		<!-- ── Files ──────────────────────────────────────────────────────────── -->
		<div>
			<h2 class="text-base font-semibold mb-3">{m.submission_details_files()}</h2>

			{#if files.length === 0}
				<p class="text-base-content/50 text-sm">{m.submission_details_no_files()}</p>
			{:else}
				<div class="flex flex-col gap-4">
					{#each files as file (file.id)}
						<div class="card bg-base-100 shadow">
							<div class="card-body py-4 gap-3">
								<div class="flex items-center justify-between gap-3 flex-wrap">
									<div>
										<p class="font-medium text-sm">{file.fieldName}</p>
										<p class="text-xs text-base-content/50">
											{file.mimeType ?? 'unknown'} · {formatBytes(file.sizeBytes)}
										</p>
									</div>
									<div class="flex gap-2">
										{#if isPreviewable(file.mimeType)}
											<button
												class="btn btn-sm btn-ghost border border-base-300"
												onclick={() => loadFile(file.id)}
												disabled={file.preview.kind === 'loading'}
											>
												{#if file.preview.kind === 'loading'}
													<span class="loading loading-spinner loading-xs"></span>
												{:else if file.preview.kind === 'ready'}
													{m.submission_details_hide_preview()}
												{:else}
													{m.submission_details_preview()}
												{/if}
											</button>
										{/if}
										<button
											class="btn btn-sm btn-ghost border border-base-300"
											onclick={() => downloadFile(file.id)}
										>
											{m.submission_details_download()}
										</button>
									</div>
								</div>

								{#if file.preview.kind === 'error'}
									<div role="alert" class="alert alert-error text-sm py-2">
										<span>{file.preview.message}</span>
									</div>
								{:else if file.preview.kind === 'ready'}
									{@const mime = file.preview.mimeType}
									{@const url = file.preview.blobUrl}
									<div class="mt-1">
										{#if mime.startsWith('image/')}
											<img src={url} alt={file.fieldName} class="max-w-full rounded-lg max-h-96 object-contain" />
										{:else if mime.startsWith('video/')}
											<!-- svelte-ignore a11y_media_has_caption -->
											<video src={url} controls class="max-w-full rounded-lg max-h-96"></video>
										{:else if mime.startsWith('audio/')}
											<audio src={url} controls class="w-full"></audio>
										{:else if mime === 'application/pdf'}
											<iframe src={url} title={file.fieldName} class="w-full h-96 rounded-lg border border-base-300"></iframe>
										{/if}
									</div>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}
