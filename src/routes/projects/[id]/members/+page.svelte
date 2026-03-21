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
	import { loadMembershipForProject } from '$lib/client/key-store';
	import { api, ApiError } from '$lib/client/api';
	import type { EncryptedKey } from '$lib/crypto/asymmetric';
	import type { MemberRecord } from '$lib/api-types';
	import type { PageData } from './$types';
	import * as m from '$lib/paraglide/messages';

	let { data }: { data: PageData } = $props();

	type PageMode = 'loading' | 'ready' | 'error';
	let mode = $state<PageMode>('loading');
	let pageError = $state('');
	let members = $state<MemberRecord[]>([]);
	let promoting = $state<string | null>(null); // memberId being promoted
	let promoteError = $state('');

	let projectPrivateKey: CryptoKey | null = null;

	onMount(async () => {
		const membership = loadMembershipForProject(data.projectId);
		if (!membership) {
			window.location.href = `/auth?projectId=${data.projectId}&next=/projects/${data.projectId}/members`;
			return;
		}

		try {
			const userBundle = await importUserKeyBundleJwk(membership.bundle);

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

	async function handlePromote(targetMemberId: string, targetEncryptionPublicKey: string) {
		if (!projectPrivateKey) {
			promoteError = 'Project private key not available — cannot promote';
			return;
		}

		promoting = targetMemberId;
		promoteError = '';

		try {
			// Re-encrypt project private key for the target member
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

			await api.members.promote(data.projectId, { targetMemberId, encryptedProjectPrivateKey });

			// Update local state
			members = members.map((m) =>
				m.memberId === targetMemberId ? { ...m, role: 'MODERATOR' as const } : m
			);
		} catch (err) {
			promoteError =
				err instanceof ApiError ? err.message : (err instanceof Error ? err.message : 'Promotion failed');
		} finally {
			promoting = null;
		}
	}
</script>

<svelte:head><title>Witness – Members</title></svelte:head>

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
		{#if promoteError}
			<div role="alert" class="alert alert-error mb-4 max-w-2xl">
				<span>{promoteError}</span>
			</div>
		{/if}

		{#if members.length === 0}
			<p class="text-base-content/60">{m.members_no_members()}</p>
		{:else}
			<div class="overflow-x-auto max-w-2xl">
				<table class="table">
					<thead>
						<tr>
							<th>{m.members_member_id_col()}</th>
							<th>{m.members_role()}</th>
							<th>{m.members_joined()}</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each members as member (member.memberId)}
							<tr>
								<td class="font-mono text-xs">{member.memberId}</td>
								<td>
									<span class="badge {member.role === 'MODERATOR' ? 'badge-primary' : 'badge-ghost'}">
										{member.role}
									</span>
								</td>
								<td class="text-xs opacity-60">{new Date(member.joinedAt).toLocaleDateString()}</td>
								<td>
									{#if member.role === 'SUBMITTER' && member.memberId !== data.currentMemberId}
										<button
											class="btn btn-xs btn-outline"
											disabled={promoting === member.memberId}
											onclick={() => handlePromote(member.memberId, member.encryptionPublicKey)}
											aria-label={`Promote ${member.memberId} to moderator`}
										>
											{#if promoting === member.memberId}
												<span class="loading loading-spinner loading-xs"></span>
											{:else}
												{m.members_promote_btn()}
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
