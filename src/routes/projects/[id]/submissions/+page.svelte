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
	import type { EncryptedKey } from '$lib/crypto/asymmetric';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type DecryptedSubmission = {
		id: string;
		userId: string;
		createdAt: string;
		fields: Record<string, string>;
		decryptError?: string;
	};

	type PageMode = 'loading' | 'ready' | 'error';
	let mode = $state<PageMode>('loading');
	let pageError = $state('');
	let submissions = $state<DecryptedSubmission[]>([]);

	onMount(async () => {
		const stored = loadStoredKeys();
		if (!stored) {
			window.location.href = `/auth?next=/projects/${data.projectId}/submissions`;
			return;
		}

		try {
			const userBundle = await importUserKeyBundleJwk(stored);

			// Moderator: decrypt the project private key first
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

			submissions = await Promise.all(
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
						return { id: s.id, userId: s.userId, createdAt: s.createdAt, fields };
					} catch {
						return {
							id: s.id,
							userId: s.userId,
							createdAt: s.createdAt,
							fields: {},
							decryptError: 'Decryption failed — key may be missing or corrupted'
						};
					}
				})
			);

			mode = 'ready';
		} catch (err) {
			pageError =
				err instanceof ApiError ? err.message : (err instanceof Error ? err.message : 'Failed to load submissions');
			mode = 'error';
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

	{:else if submissions.length === 0}
		<p class="text-base-content/60">No submissions yet.</p>

	{:else}
		<div class="flex flex-col gap-4 max-w-2xl">
			{#each submissions as sub (sub.id)}
				<div class="card bg-base-100 shadow" data-testid="submission-card">
					<div class="card-body">
						<div class="flex items-center justify-between mb-2">
							<span class="text-xs font-mono opacity-60">ID: {sub.id}</span>
							<span class="text-xs opacity-60">{formatDate(sub.createdAt)}</span>
						</div>

						{#if sub.decryptError}
							<div role="alert" class="alert alert-error text-sm">
								<span>{sub.decryptError}</span>
							</div>
						{:else}
							<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
								{#each Object.entries(sub.fields) as [key, value] (key)}
									<dt class="font-medium text-sm opacity-70">{key}</dt>
									<dd class="text-sm">{value}</dd>
								{/each}
							</dl>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
