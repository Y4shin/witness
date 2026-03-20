<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '$lib/paraglide/messages';
	import PrivacyInfoModal from '$lib/components/PrivacyInfoModal.svelte';
	import { listProjectMemberships } from '$lib/client/key-store';

	let privacyOpen = $state(false);
	let projects = $state<{ projectId: string; projectName: string; role: 'SUBMITTER' | 'MODERATOR' }[]>([]);

	onMount(() => {
		projects = listProjectMemberships();
	});
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
</div>
