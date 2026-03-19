<script lang="ts">
	import { onMount } from 'svelte';
	import {
		decryptSymmetricKey,
		decryptSymmetric,
		importEcdhPrivateKey,
		importEcdhPublicKey,
		encryptSymmetricKeyFor,
		generateSymmetricKey,
		encryptSymmetric,
		exportPrivateKeyPkcs8,
		importUserKeyBundleJwk,
		stringToJwk
	} from '$lib/crypto';
	import { loadStoredKeys } from '$lib/client/key-store';
	import { api, ApiError } from '$lib/client/api';
	import type { EncryptedKey } from '$lib/crypto/asymmetric';
	import type { MemberRecord } from '$lib/api-types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type PageMode = 'loading' | 'ready' | 'error';
	let mode = $state<PageMode>('loading');
	let pageError = $state('');
	let members = $state<MemberRecord[]>([]);
	let promoting = $state<string | null>(null); // userId being promoted
	let promoteError = $state('');

	let projectPrivateKey: CryptoKey | null = null;

	onMount(async () => {
		const stored = loadStoredKeys();
		if (!stored) {
			window.location.href = `/auth?next=/projects/${data.projectId}/members`;
			return;
		}

		try {
			const userBundle = await importUserKeyBundleJwk(stored);

			// Decrypt the project private key (needed for promotion)
			if (data.encryptedProjectPrivateKey) {
				const encProjKey = JSON.parse(data.encryptedProjectPrivateKey) as {
					payload: string;
					key: EncryptedKey;
				};
				const symKey = await decryptSymmetricKey(encProjKey.key, userBundle.encryption.privateKey);
				const pkcs8 = await decryptSymmetric(symKey, encProjKey.payload);
				projectPrivateKey = await importEcdhPrivateKey(pkcs8);
			}

			const { members: fetched } = await api.members.list(data.projectId);
			members = fetched;
			mode = 'ready';
		} catch (err) {
			pageError =
				err instanceof ApiError ? err.message : (err instanceof Error ? err.message : 'Failed to load members');
			mode = 'error';
		}
	});

	async function handlePromote(targetUserId: string, targetEncryptionPublicKey: string) {
		if (!projectPrivateKey) {
			promoteError = 'Project private key not available — cannot promote';
			return;
		}

		promoting = targetUserId;
		promoteError = '';

		try {
			// Re-encrypt project private key for the target user
			const pkcs8 = await exportPrivateKeyPkcs8(projectPrivateKey);
			const symKey = await generateSymmetricKey();
			const targetPubKey = await importEcdhPublicKey(stringToJwk(targetEncryptionPublicKey));

			const [encryptedPayload, encryptedSymKey] = await Promise.all([
				encryptSymmetric(symKey, pkcs8),
				encryptSymmetricKeyFor(symKey, targetPubKey)
			]);
			const encryptedProjectPrivateKey = JSON.stringify({
				payload: encryptedPayload,
				key: encryptedSymKey
			});

			await api.members.promote(data.projectId, { targetUserId, encryptedProjectPrivateKey });

			// Update local state
			members = members.map((m) =>
				m.userId === targetUserId ? { ...m, role: 'OBSERVER' as const } : m
			);
		} catch (err) {
			promoteError =
				err instanceof ApiError ? err.message : (err instanceof Error ? err.message : 'Promotion failed');
		} finally {
			promoting = null;
		}
	}
</script>

<div class="min-h-screen p-6">
	<h1 class="mb-6 text-2xl font-bold">Project members</h1>

	{#if mode === 'loading'}
		<div class="flex justify-center">
			<span class="loading loading-spinner loading-lg"></span>
		</div>

	{:else if mode === 'error'}
		<div role="alert" class="alert alert-error mx-auto max-w-xl">
			<span>{pageError}</span>
		</div>

	{:else}
		{#if promoteError}
			<div role="alert" class="alert alert-error mb-4 max-w-2xl">
				<span>{promoteError}</span>
			</div>
		{/if}

		{#if members.length === 0}
			<p class="text-base-content/60">No members found.</p>
		{:else}
			<div class="overflow-x-auto max-w-2xl">
				<table class="table">
					<thead>
						<tr>
							<th>User ID</th>
							<th>Role</th>
							<th>Joined</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each members as member (member.userId)}
							<tr>
								<td class="font-mono text-xs">{member.userId}</td>
								<td>
									<span class="badge {member.role === 'OBSERVER' ? 'badge-primary' : 'badge-ghost'}">
										{member.role}
									</span>
								</td>
								<td class="text-xs opacity-60">{new Date(member.joinedAt).toLocaleDateString()}</td>
								<td>
									{#if member.role === 'SUBMITTER' && member.userId !== data.currentUserId}
										<button
											class="btn btn-xs btn-outline"
											disabled={promoting === member.userId}
											onclick={() => handlePromote(member.userId, member.encryptionPublicKey)}
											aria-label={`Promote ${member.userId} to observer`}
										>
											{#if promoting === member.userId}
												<span class="loading loading-spinner loading-xs"></span>
											{:else}
												Promote
											{/if}
										</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{/if}
</div>
