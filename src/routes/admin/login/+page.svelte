<script lang="ts">
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head><title>Witness – Admin Login</title></svelte:head>

<div class="min-h-screen flex items-center justify-center p-4">
	<div class="card bg-base-100 shadow-xl w-full max-w-sm">
		<div class="card-body">
			<h1 class="card-title text-xl mb-4">Admin login</h1>

			{#if form?.error}
				<div role="alert" class="alert alert-error mb-4">
					<span>{form.error}</span>
				</div>
			{/if}

			<form method="POST">
				<div class="form-control mb-4">
					<label class="label" for="password">
						<span class="label-text">Password</span>
					</label>
					<input
						id="password"
						name="password"
						type="password"
						class="input input-bordered"
						autocomplete="current-password"
						required
					/>
				</div>
				<button type="submit" class="btn btn-primary w-full">Sign in</button>
			</form>
		</div>
	</div>
</div>
