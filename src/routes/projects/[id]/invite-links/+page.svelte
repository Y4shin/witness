<script lang="ts">
	import InviteManager from '$lib/components/InviteManager.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<div class="min-h-screen p-6">
	<h1 class="mb-6 text-2xl font-bold">Invite links</h1>
	<div class="max-w-2xl">
		<InviteManager projectId={data.projectId} />
	</div>
</div>
