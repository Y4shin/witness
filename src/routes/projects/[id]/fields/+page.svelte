<script lang="ts">
	import FormBuilder from '$lib/components/FormBuilder.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<div class="min-h-screen p-6">
	<h1 class="mb-6 text-2xl font-bold">Form Builder</h1>
	<div class="mx-auto max-w-2xl">
		<FormBuilder projectId={data.projectId} fields={data.fields} />
	</div>
</div>
