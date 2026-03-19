<script lang="ts">
	import { onMount } from 'svelte';
	import {
		decryptSymmetricKey,
		decryptSymmetric,
		importEcdhPrivateKey,
		importUserKeyBundleJwk
	} from '$lib/crypto';
	import { loadStoredKeys } from '$lib/client/key-store';
	import { api, ApiError } from '$lib/client/api';
	import { openCacheDb, initCacheKey, readCacheEntry, writeCacheEntry } from '$lib/stores/cache';
	import { SUBMISSION_TYPE_LABELS } from '$lib/submission-types';
	import type { EncryptedKey } from '$lib/crypto/asymmetric';
	import type { SubmissionType } from '$lib/api-types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type DecryptedSubmission = {
		id: string;
		userId: string;
		createdAt: string;
		type: SubmissionType;
		archiveUrl: string | null;
		fileCount: number;
		fields: Record<string, string>;
		decryptError?: string;
	};

	type PageMode = 'loading' | 'cached' | 'ready' | 'error';
	let mode = $state<PageMode>('loading');
	let pageError = $state('');
	let submissions = $state<DecryptedSubmission[]>([]);
	let refreshing = $state(false);

	const CACHE_KEY = `submissions:${data.projectId}`;

	onMount(async () => {
		const stored = loadStoredKeys();
		if (!stored) {
			window.location.href = `/auth?next=/projects/${data.projectId}/submissions`;
			return;
		}

		try {
			const userBundle = await importUserKeyBundleJwk(stored);

			// Derive cache encryption key and open DB
			const [cacheDb, cacheKey] = await Promise.all([
				openCacheDb(),
				initCacheKey(userBundle.encryption.privateKey)
			]);

			// Try to show cached submissions immediately
			try {
				const cached = await readCacheEntry<DecryptedSubmission[]>(cacheDb, cacheKey, CACHE_KEY);
				if (cached && cached.length > 0) {
					submissions = cached;
					mode = 'cached';
				}
			} catch {
				// Cache miss or decryption error — continue to fetch fresh
			}

			refreshing = mode === 'cached';

			// Decrypt the project private key (moderators only)
			let projectPrivateKey: CryptoKey | null = null;
			if (data.role === 'MODERATOR' && data.encryptedProjectPrivateKey) {
				const encProjKey = JSON.parse(data.encryptedProjectPrivateKey) as {
					payload: string;
					key: EncryptedKey;
				};
				const symKey = await decryptSymmetricKey(encProjKey.key, userBundle.encryption.privateKey);
				const pkcs8 = await decryptSymmetric(symKey, encProjKey.payload);
				projectPrivateKey = await importEcdhPrivateKey(pkcs8);
			}

			const { submissions: raw } = await api.submissions.list(data.projectId);

			const fresh = await Promise.all(
				raw.map(async (s) => {
					try {
						let symKey: CryptoKey;
						if (data.role === 'MODERATOR' && projectPrivateKey) {
							const encKeyProject = JSON.parse(s.encryptedKeyProject) as EncryptedKey;
							symKey = await decryptSymmetricKey(encKeyProject, projectPrivateKey);
						} else {
							const encKeyUser = JSON.parse(s.encryptedKeyUser) as EncryptedKey;
							symKey = await decryptSymmetricKey(encKeyUser, userBundle.encryption.privateKey);
						}
						const plaintext = await decryptSymmetric(symKey, s.encryptedPayload);
						const fields = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, string>;
						return { id: s.id, userId: s.userId, createdAt: s.createdAt, type: s.type, archiveUrl: s.archiveUrl, fileCount: s.fileCount, fields };
					} catch {
						return {
							id: s.id,
							userId: s.userId,
							createdAt: s.createdAt,
							type: s.type,
							archiveUrl: s.archiveUrl,
							fileCount: s.fileCount,
							fields: {},
							decryptError: 'Decryption failed — key may be missing or corrupted'
						};
					}
				})
			);

			submissions = fresh;
			mode = 'ready';

			// Write decrypted results to cold storage (best-effort)
			writeCacheEntry(cacheDb, cacheKey, CACHE_KEY, fresh).catch(() => {});
		} catch (err) {
			if (mode !== 'cached') {
				pageError =
					err instanceof ApiError ? err.message : (err instanceof Error ? err.message : 'Failed to load submissions');
				mode = 'error';
			}
			// If we already have cached data, keep showing it; don't override with error state
		} finally {
			refreshing = false;
		}
	});

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleString();
	}
</script>

<div>
	{#if mode === 'loading'}
		<div class="flex justify-center">
			<span class="loading loading-spinner loading-lg"></span>
		</div>

	{:else if mode === 'error'}
		<div role="alert" class="alert alert-error mx-auto max-w-xl">
			<span>{pageError}</span>
		</div>

	{:else}
		{#if refreshing}
			<div class="flex items-center gap-2 mb-4 text-sm text-base-content/50">
				<span class="loading loading-spinner loading-xs"></span>
				Refreshing…
			</div>
		{/if}

		{#if submissions.length === 0}
			<p class="text-base-content/60">No submissions yet.</p>
		{:else}
			<div class="flex flex-col gap-4 max-w-2xl">
				{#each submissions as sub (sub.id)}
					<div class="card bg-base-100 shadow" data-testid="submission-card">
						<div class="card-body">
							<div class="flex items-start justify-between mb-2 gap-2 flex-wrap">
								<div class="flex items-center gap-2 flex-wrap">
									<span class="badge badge-primary badge-sm">{SUBMISSION_TYPE_LABELS[sub.type]}</span>
									{#if sub.fileCount > 0}
										<span class="badge badge-ghost badge-sm">{sub.fileCount} file{sub.fileCount !== 1 ? 's' : ''}</span>
									{/if}
									<span class="text-xs font-mono opacity-60">ID: {sub.id}</span>
								</div>
								<span class="text-xs opacity-60">{formatDate(sub.createdAt)}</span>
							</div>

							{#if sub.archiveUrl}
								<div class="mb-2">
									<a
										href={sub.archiveUrl}
										target="_blank"
										rel="noopener noreferrer"
										class="link link-primary text-xs"
									>
										Archive snapshot →
									</a>
								</div>
							{/if}

							{#if sub.decryptError}
								<div role="alert" class="alert alert-error text-sm">
									<span>{sub.decryptError}</span>
								</div>
							{:else}
								<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
									{#each Object.entries(sub.fields) as [key, value] (key)}
										<dt class="font-medium text-sm opacity-70 capitalize">{key}</dt>
										<dd class="text-sm break-all">{value}</dd>
									{/each}
								</dl>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>
