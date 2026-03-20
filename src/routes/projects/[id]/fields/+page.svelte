<script lang="ts">
	import FormBuilder from '$lib/components/FormBuilder.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Witness – Fields</title></svelte:head>

<div class="max-w-2xl">
	<FormBuilder projectId={data.projectId} fields={data.fields} />
</div>
