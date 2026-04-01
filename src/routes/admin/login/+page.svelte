<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import * as m from '$lib/paraglide/messages';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const errorMessage = $derived(form?.error ?? data.error);
</script>

<svelte:head><title>Witness - Admin Login</title></svelte:head>

<div class="flex min-h-screen items-center justify-center p-4">
	<div class="card w-full max-w-sm bg-base-100 shadow-xl">
		<div class="card-body">
			<h1 class="mb-4 card-title text-xl">{m.admin_login_title()}</h1>

			{#if errorMessage}
				<div role="alert" class="mb-4 alert alert-error">
					<span>{errorMessage}</span>
				</div>
			{/if}

			{#if data.authMode === 'password'}
				<form method="POST">
					<div class="form-control mb-4">
						<label class="label" for="password">
							<span class="label-text">{m.admin_password_label()}</span>
						</label>
						<input
							id="password"
							name="password"
							type="password"
							class="input-bordered input"
							autocomplete="current-password"
							required
						/>
					</div>
					<button type="submit" class="btn w-full btn-primary">{m.admin_sign_in_btn()}</button>
				</form>
			{:else}
				<p class="mb-4 text-sm text-base-content/70">{m.admin_oidc_login_hint()}</p>
				<a href="/admin/login/oidc" class="btn w-full btn-primary">{m.admin_oidc_sign_in_btn()}</a>
			{/if}
		</div>
	</div>
</div>
