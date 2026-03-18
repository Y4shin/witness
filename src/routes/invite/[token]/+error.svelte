<script lang="ts">
	import { page } from '$app/state';
</script>

<div class="min-h-screen flex items-center justify-center p-4">
	<div class="card bg-base-100 shadow-xl w-full max-w-sm">
		<div class="card-body items-center text-center">
			{#if page.status === 410}
				<h1 class="card-title text-xl">Link no longer valid</h1>
				<p class="text-base-content/70">{page.error?.message}</p>
			{:else if page.status === 404}
				<h1 class="card-title text-xl">Link not found</h1>
				<p class="text-base-content/70">This invite link does not exist.</p>
			{:else}
				<h1 class="card-title text-xl">Something went wrong</h1>
				<p class="text-base-content/70">{page.error?.message ?? 'An unexpected error occurred.'}</p>
			{/if}
			<a href="/" class="btn btn-ghost btn-sm mt-2">Go home</a>
		</div>
	</div>
</div>
