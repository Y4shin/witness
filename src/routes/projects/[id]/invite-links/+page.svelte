<script lang="ts">
	import InviteManager from '$lib/components/InviteManager.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Witness – Invite Links</title></svelte:head>

<div class="max-w-2xl">
	<InviteManager projectId={data.projectId} />
</div>
