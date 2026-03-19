<script lang="ts">
	import type { PageData } from './$types';
	import * as m from '$lib/paraglide/messages';

	let { data }: { data: PageData } = $props();
</script>

<div class="p-6 max-w-3xl mx-auto">
	<h1 class="text-2xl font-bold mb-6">{m.dashboard_title()}</h1>

	{#if data.projects.length === 0}
		<p class="text-base-content/60">{m.dashboard_no_projects()}</p>
	{:else}
		<div class="flex flex-col gap-3">
			{#each data.projects as project (project.id)}
				<div class="card bg-base-200 shadow-sm">
					<div class="card-body py-4 px-5">
						<div class="flex items-center justify-between gap-4">
							<div>
								<h2 class="font-semibold text-lg">{project.name}</h2>
								<span class="badge badge-outline badge-sm mt-1">{project.role}</span>
							</div>
							<div class="flex gap-2 flex-wrap justify-end">
								{#if project.role === 'SUBMITTER'}
									<a href="/projects/{project.id}/submit" class="btn btn-primary btn-sm">{m.dashboard_submit()}</a>
									<a href="/projects/{project.id}/submissions" class="btn btn-ghost btn-sm">{m.dashboard_my_submissions()}</a>
								{:else}
									<a href="/projects/{project.id}/submissions" class="btn btn-primary btn-sm">{m.dashboard_submissions()}</a>
									<a href="/projects/{project.id}/members" class="btn btn-ghost btn-sm">{m.dashboard_members()}</a>
									<a href="/projects/{project.id}/invite-links" class="btn btn-ghost btn-sm">{m.dashboard_invite_links()}</a>
									<a href="/projects/{project.id}/fields" class="btn btn-ghost btn-sm">{m.dashboard_form_fields()}</a>
								{/if}
							</div>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
