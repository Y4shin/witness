<script lang="ts">
	import { PUBLIC_VERSION } from '$env/static/public';
	import type { PageData, ActionData } from './$types';
	import QrCode from '$lib/components/QrCode.svelte';
	import * as m from '$lib/paraglide/messages';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Track which project's delete confirmation is shown
	let confirmDeleteId = $state<string | null>(null);
</script>

<svelte:head><title>Witness – Admin</title></svelte:head>

<div class="min-h-screen bg-base-200 p-6">
	<div class="max-w-3xl mx-auto space-y-6">
		<!-- Header -->
		<div class="flex items-center justify-between">
			<h1 class="text-2xl font-bold">{m.admin_console_title()}</h1>
			<form method="POST" action="?/logout">
				<button type="submit" class="btn btn-ghost btn-sm">{m.admin_sign_out_btn()}</button>
			</form>
		</div>

		<!-- Create project -->
		<div class="card bg-base-100 shadow">
			<div class="card-body">
				<h2 class="card-title text-lg">{m.admin_create_project_title()}</h2>

				{#if form?.createError}
					<div role="alert" class="alert alert-error">
						<span>{form.createError}</span>
					</div>
				{/if}

				<form method="POST" action="?/createProject" id="create-form" class="flex gap-2">
					<input
						name="name"
						type="text"
						placeholder={m.admin_project_name_placeholder()}
						class="input input-bordered flex-1"
						required
					/>
					<button type="submit" class="btn btn-primary">{m.admin_create_btn()}</button>
				</form>

				{#if form?.created}
					<div class="mt-4 p-4 border border-success rounded-box space-y-3">
						<p class="font-semibold text-success">
							{m.admin_project_created()} <span class="font-mono">{form.created.name}</span>
						</p>
						<p class="text-sm">{m.admin_moderator_invite_text()}</p>
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
								{m.admin_copy_btn()}
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
				<h2 class="card-title text-lg">{m.admin_projects_title()}</h2>

				{#if form?.deleteError}
					<div role="alert" class="alert alert-error">
						<span>{form.deleteError}</span>
					</div>
				{/if}

				{#if data.projects.length === 0}
					<p class="text-base-content/60">{m.admin_no_projects()}</p>
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
												{m.admin_confirm_delete_btn()}
											</button>
										</form>
										<button
											class="btn btn-ghost btn-sm"
											onclick={() => (confirmDeleteId = null)}
										>
											{m.admin_cancel_btn()}
										</button>
									</div>
								{:else}
									<button
										data-testid="delete-project"
										class="btn btn-ghost btn-sm text-error"
										onclick={() => (confirmDeleteId = project.id)}
									>
										{m.admin_delete_btn()}
									</button>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</div>

	{#if data.version}
		<p class="text-center text-xs text-base-content/40 pt-2">v{data.version}</p>
	{/if}
</div>
