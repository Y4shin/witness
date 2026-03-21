<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '$lib/paraglide/messages';
	import PrivacyInfoModal from '$lib/components/PrivacyInfoModal.svelte';
	import { listProjectMemberships } from '$lib/client/key-store';

	let privacyOpen = $state(false);
	let projects = $state<{ projectId: string; projectName: string; role: 'SUBMITTER' | 'MODERATOR' }[]>([]);
	let inviteInput = $state('');
	let inviteError = $state('');

	onMount(() => {
		projects = listProjectMemberships();
	});

	function extractToken(raw: string): string | null {
		const trimmed = raw.trim();
		if (!trimmed) return null;
		const match = trimmed.match(/\/invite\/([^/?#\s]+)/);
		if (match) return match[1];
		if (!trimmed.includes('/')) return trimmed;
		return null;
	}

	function goToInvite() {
		const token = extractToken(inviteInput);
		if (!token) {
			inviteError = 'Paste a valid invite link or token.';
			return;
		}
		window.location.href = `/invite/${token}`;
	}
</script>

<svelte:head><title>Witness – Dashboard</title></svelte:head>

<PrivacyInfoModal open={privacyOpen} onclose={() => (privacyOpen = false)} />

<div class="p-6 max-w-3xl mx-auto">
	<div class="flex items-center justify-between mb-6">
		<h1 class="text-2xl font-bold">{m.dashboard_title()}</h1>
		<button class="btn btn-ghost btn-xs" onclick={() => (privacyOpen = true)}>
			{m.privacy_help_btn()}
		</button>
	</div>

	{#if projects.length === 0}
		<p class="text-base-content/60">{m.dashboard_no_projects()}</p>
	{:else}
		<div class="flex flex-col gap-3">
			{#each projects as project (project.projectId)}
				<div class="card bg-base-200 shadow-sm">
					<div class="card-body py-4 px-5">
						<div class="flex items-center justify-between gap-4">
							<div>
								<h2 class="font-semibold text-lg">{project.projectName}</h2>
								<span class="badge badge-outline badge-sm mt-1">{project.role}</span>
							</div>
							<div class="flex gap-2 flex-wrap justify-end">
								{#if project.role === 'SUBMITTER'}
									<a href="/projects/{project.projectId}/submit" class="btn btn-primary btn-sm">{m.dashboard_submit()}</a>
									<a href="/projects/{project.projectId}/submissions" class="btn btn-ghost btn-sm">{m.dashboard_my_submissions()}</a>
								{:else}
									<a href="/projects/{project.projectId}/submissions" class="btn btn-primary btn-sm">{m.dashboard_submissions()}</a>
									<a href="/projects/{project.projectId}/members" class="btn btn-ghost btn-sm">{m.dashboard_members()}</a>
									<a href="/projects/{project.projectId}/invite-links" class="btn btn-ghost btn-sm">{m.dashboard_invite_links()}</a>
									<a href="/projects/{project.projectId}/fields" class="btn btn-ghost btn-sm">{m.dashboard_form_fields()}</a>
								{/if}
							</div>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<div class="divider mt-6"></div>

	<div class="max-w-md">
		<p class="text-sm font-semibold mb-2">Join another project</p>
		<div class="flex gap-2">
			<input
				type="text"
				class="input input-bordered flex-1 text-sm"
				placeholder="Paste an invite link or token"
				bind:value={inviteInput}
				oninput={() => (inviteError = '')}
				onkeydown={(e) => { if (e.key === 'Enter') goToInvite(); }}
			/>
			<button class="btn btn-primary btn-sm self-center" onclick={goToInvite}>Go</button>
		</div>
		{#if inviteError}
			<p class="text-error text-sm mt-1">{inviteError}</p>
		{/if}
	</div>
</div>
