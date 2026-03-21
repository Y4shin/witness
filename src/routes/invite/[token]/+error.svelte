<script lang="ts">
	import { page } from '$app/state';
	import * as m from '$lib/paraglide/messages';
</script>

<div class="min-h-screen flex items-center justify-center p-4">
	<div class="card bg-base-100 shadow-xl w-full max-w-sm">
		<div class="card-body items-center text-center">
			{#if page.status === 410}
				<h1 class="card-title text-xl">{m.invite_error_expired()}</h1>
				<p class="text-base-content/70">{page.error?.message}</p>
			{:else if page.status === 404}
				<h1 class="card-title text-xl">{m.invite_error_not_found()}</h1>
				<p class="text-base-content/70">{m.invite_error_not_found_body()}</p>
			{:else}
				<h1 class="card-title text-xl">{m.invite_error_generic()}</h1>
				<p class="text-base-content/70">{page.error?.message ?? m.invite_error_generic_body()}</p>
			{/if}
			<a href="/" class="btn btn-ghost btn-sm mt-2">{m.invite_go_home()}</a>
		</div>
	</div>
</div>
