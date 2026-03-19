<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<div class="p-6 max-w-3xl mx-auto">
	<h1 class="text-2xl font-bold mb-6">Your projects</h1>

	{#if data.projects.length === 0}
		<p class="text-base-content/60">You are not a member of any projects yet.</p>
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
									<a href="/projects/{project.id}/submit" class="btn btn-primary btn-sm">Submit</a>
									<a href="/projects/{project.id}/submissions" class="btn btn-ghost btn-sm">My submissions</a>
								{:else}
									<a href="/projects/{project.id}/submissions" class="btn btn-primary btn-sm">Submissions</a>
									<a href="/projects/{project.id}/members" class="btn btn-ghost btn-sm">Members</a>
									<a href="/projects/{project.id}/invite-links" class="btn btn-ghost btn-sm">Invite links</a>
									<a href="/projects/{project.id}/fields" class="btn btn-ghost btn-sm">Form fields</a>
								{/if}
							</div>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
