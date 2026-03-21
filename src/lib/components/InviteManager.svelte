<script lang="ts">
	import { api, ApiError } from '$lib/client/api';
	import QrCode from './QrCode.svelte';
	import type { InviteLinkRecord } from '$lib/api-types';
	import * as m from '$lib/paraglide/messages';

	let { projectId }: { projectId: string } = $props();

	// ── form state ──────────────────────────────────────────────────────────
	let role = $state<'SUBMITTER' | 'MODERATOR'>('SUBMITTER');
	let maxUsesStr = $state('');
	let expiresAtStr = $state('');
	let creating = $state(false);
	let createError = $state('');

	// ── list state ──────────────────────────────────────────────────────────
	let invites = $state<InviteLinkRecord[]>([]);
	let loadError = $state('');
	let revoking = $state<string | null>(null);

	// ── derived ─────────────────────────────────────────────────────────────
	let expandedToken = $state<string | null>(null);

	function inviteUrl(token: string): string {
		if (typeof window === 'undefined') return `/invite/${token}`;
		return `${window.location.origin}/invite/${token}`;
	}

	// ── load invites on mount ───────────────────────────────────────────────
	$effect(() => {
		void loadInvites();
	});

	async function loadInvites() {
		loadError = '';
		try {
			const { invites: fetched } = await api.invites.listForProject(projectId);
			invites = fetched;
		} catch (err) {
			loadError = err instanceof ApiError ? err.message : 'Failed to load invite links';
		}
	}

	async function handleCreate() {
		createError = '';
		creating = true;
		try {
			const maxUses = maxUsesStr.trim() ? parseInt(maxUsesStr.trim(), 10) : null;
			if (maxUsesStr.trim() && (isNaN(maxUses!) || maxUses! < 1)) {
				createError = 'Max uses must be a positive integer';
				return;
			}
			const expiresAt = expiresAtStr.trim() ? new Date(expiresAtStr.trim()).toISOString() : null;
			if (expiresAtStr.trim() && expiresAt && new Date(expiresAt) <= new Date()) {
				createError = 'Expiry must be in the future';
				return;
			}

			await api.invites.create({ projectId, role, maxUses, expiresAt });
			maxUsesStr = '';
			expiresAtStr = '';
			await loadInvites();
		} catch (err) {
			createError = err instanceof ApiError ? err.message : 'Failed to create invite link';
		} finally {
			creating = false;
		}
	}

	async function handleRevoke(token: string) {
		revoking = token;
		try {
			await api.invites.revoke(token);
			invites = invites.filter((i) => i.token !== token);
			if (expandedToken === token) expandedToken = null;
		} catch (err) {
			loadError = err instanceof ApiError ? err.message : 'Failed to revoke invite link';
		} finally {
			revoking = null;
		}
	}
</script>

<div class="flex flex-col gap-6">
	<!-- Create form -->
	<div class="card bg-base-200">
		<div class="card-body">
			<h2 class="card-title text-lg">{m.invite_create_title()}</h2>

			<div class="flex flex-wrap gap-3 items-end">
				<label class="flex flex-col gap-1">
					<span class="label-text text-sm">{m.invite_role_label()}</span>
					<select
						class="select select-bordered select-sm"
						bind:value={role}
						aria-label={m.invite_role_label()}
					>
						<option value="SUBMITTER">{m.invite_submitter_option()}</option>
						<option value="MODERATOR">{m.invite_moderator_option()}</option>
					</select>
				</label>

				<label class="flex flex-col gap-1">
					<span class="label-text text-sm">{m.invite_max_uses_label()}</span>
					<input
						type="text"
						inputmode="numeric"
						pattern="[0-9]*"
						class="input input-bordered input-sm w-28"
						placeholder={m.invite_max_uses_placeholder()}
						bind:value={maxUsesStr}
						aria-label={m.invite_max_uses_label()}
					/>
				</label>

				<label class="flex flex-col gap-1">
					<span class="label-text text-sm">{m.invite_expires_label()}</span>
					<input
						type="datetime-local"
						class="input input-bordered input-sm"
						bind:value={expiresAtStr}
						aria-label={m.invite_expires_label()}
					/>
				</label>

				<button
					class="btn btn-primary btn-sm"
					disabled={creating}
					onclick={handleCreate}
					aria-label={m.invite_create_btn()}
					data-testid="create-invite-btn"
				>
					{#if creating}
						<span class="loading loading-spinner loading-xs"></span>
					{:else}
						{m.invite_create_btn()}
					{/if}
				</button>
			</div>

			{#if createError}
				<div role="alert" class="alert alert-error mt-2 py-2 text-sm">
					<span>{createError}</span>
				</div>
			{/if}
		</div>
	</div>

	<!-- Invite list -->
	{#if loadError}
		<div role="alert" class="alert alert-error text-sm">
			<span>{loadError}</span>
		</div>
	{:else if invites.length === 0}
		<p class="text-base-content/60 text-sm">{m.invite_no_links()}</p>
	{:else}
		<div class="flex flex-col gap-3">
			{#each invites as invite (invite.token)}
				<div class="card bg-base-100 shadow-sm" data-testid="invite-card">
					<div class="card-body py-3 px-4">
						<div class="flex items-center justify-between gap-2 flex-wrap">
							<div class="flex items-center gap-2">
								<span class="badge badge-outline badge-sm">{invite.role}</span>
								<span class="font-mono text-xs opacity-60 truncate max-w-48">{invite.token}</span>
								{#if invite.maxUses !== null}
									<span class="text-xs opacity-60">{invite.usedCount}/{invite.maxUses} uses</span>
								{:else}
									<span class="text-xs opacity-60">{invite.usedCount} uses</span>
								{/if}
								{#if invite.expiresAt}
									<span class="text-xs opacity-60">
										{m.invite_expires_prefix()} {new Date(invite.expiresAt).toLocaleDateString()}
									</span>
								{/if}
							</div>

							<div class="flex gap-2">
								<button
									class="btn btn-xs btn-ghost"
									onclick={() => expandedToken = expandedToken === invite.token ? null : invite.token}
									aria-label={`Toggle QR code for ${invite.token}`}
								>
									QR
								</button>
								<button
									class="btn btn-xs btn-error btn-outline"
									disabled={revoking === invite.token}
									onclick={() => handleRevoke(invite.token)}
									aria-label={`Revoke invite ${invite.token}`}
								>
									{#if revoking === invite.token}
										<span class="loading loading-spinner loading-xs"></span>
									{:else}
										{m.invite_revoke_btn()}
									{/if}
								</button>
							</div>
						</div>

						{#if expandedToken === invite.token}
							<div class="mt-3 flex flex-col gap-2">
								<input
									type="text"
									readonly
									class="input input-bordered input-sm font-mono text-xs"
									value={inviteUrl(invite.token)}
									aria-label={`Invite link URL for ${invite.token}`}
									onclick={(e) => (e.target as HTMLInputElement).select()}
								/>
								<div class="flex justify-center">
									<QrCode value={inviteUrl(invite.token)} />
								</div>
							</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
