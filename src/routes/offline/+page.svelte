<script lang="ts">
	import * as m from '$lib/paraglide/messages';
</script>

<svelte:head><title>Witness</title></svelte:head>

<div class="min-h-screen flex flex-col items-center justify-center p-8 gap-6 text-center">
	<svg
		xmlns="http://www.w3.org/2000/svg"
		class="size-16 opacity-40"
		fill="none"
		viewBox="0 0 24 24"
		stroke="currentColor"
		stroke-width="1.5"
		aria-hidden="true"
	>
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			d="M18.364 5.636a9 9 0 0 1 0 12.728M5.636 5.636a9 9 0 0 0 0 12.728M12 12h.01M3 3l18 18"
		/>
	</svg>

	<div class="flex flex-col gap-2">
		<h1 class="text-2xl font-semibold">{m.offline_title()}</h1>
		<p class="text-base-content/60">{m.offline_message()}</p>
	</div>

	<button class="btn btn-primary" onclick={() => location.reload()}>
		{m.offline_retry()}
	</button>
</div>
