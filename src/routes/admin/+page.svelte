<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import QrCode from '$lib/components/QrCode.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Track which project's delete confirmation is shown
	let confirmDeleteId = $state<string | null>(null);
</script>

<div class="min-h-screen bg-base-200 p-6">
	<div class="max-w-3xl mx-auto space-y-6">
		<!-- Header -->
		<div class="flex items-center justify-between">
			<h1 class="text-2xl font-bold">Admin console</h1>
			<form method="POST" action="?/logout">
				<button type="submit" class="btn btn-ghost btn-sm">Sign out</button>
			</form>
		</div>

		<!-- Create project -->
		<div class="card bg-base-100 shadow">
			<div class="card-body">
				<h2 class="card-title text-lg">Create project</h2>

				{#if form?.createError}
					<div role="alert" class="alert alert-error">
						<span>{form.createError}</span>
					</div>
				{/if}

				<form method="POST" action="?/createProject" id="create-form" class="flex gap-2">
					<input
						name="name"
						type="text"
						placeholder="Project name"
						class="input input-bordered flex-1"
						required
					/>
					<button type="submit" class="btn btn-primary">Create</button>
				</form>

				{#if form?.created}
					<div class="mt-4 p-4 border border-success rounded-box space-y-3">
						<p class="font-semibold text-success">
							Project <span class="font-mono">{form.created.name}</span> created.
						</p>
						<p class="text-sm">Share this one-time MODERATOR invite link:</p>
						<div class="flex items-center gap-2">
							<code
								data-testid="invite-link"
								class="bg-base-200 px-3 py-1 rounded text-sm break-all flex-1"
							>
								{form.created.inviteUrl}
							</code>
							<button
								class="btn btn-ghost btn-sm"
								onclick={() => navigator.clipboard.writeText(form.created.inviteUrl)}
							>
								Copy
							</button>
						</div>
						<div data-testid="qr-code" class="w-40">
							<QrCode value={form.created.inviteUrl} />
						</div>
					</div>
				{/if}
			</div>
		</div>

		<!-- Project list -->
		<div class="card bg-base-100 shadow">
			<div class="card-body">
				<h2 class="card-title text-lg">Projects</h2>

				{#if form?.deleteError}
					<div role="alert" class="alert alert-error">
						<span>{form.deleteError}</span>
					</div>
				{/if}

				{#if data.projects.length === 0}
					<p class="text-base-content/60">No projects yet.</p>
				{:else}
					<ul class="space-y-2">
						{#each data.projects as project (project.id)}
							<li class="flex items-center justify-between p-3 bg-base-200 rounded-box">
								<div>
									<span class="font-medium">{project.name}</span>
									<span class="text-xs text-base-content/50 ml-2 font-mono">{project.id}</span>
								</div>

								{#if confirmDeleteId === project.id}
									<div class="flex gap-2">
										<form method="POST" action="?/deleteProject">
											<input type="hidden" name="id" value={project.id} />
											<button
												type="submit"
												data-testid="confirm-delete-project"
												class="btn btn-error btn-sm"
											>
												Confirm delete
											</button>
										</form>
										<button
											class="btn btn-ghost btn-sm"
											onclick={() => (confirmDeleteId = null)}
										>
											Cancel
										</button>
									</div>
								{:else}
									<button
										data-testid="delete-project"
										class="btn btn-ghost btn-sm text-error"
										onclick={() => (confirmDeleteId = project.id)}
									>
										Delete
									</button>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</div>
</div>
