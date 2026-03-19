<script lang="ts">
	import { page } from '$app/state';
	import type { LayoutData } from './$types';

	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();

	const base = $derived(`/projects/${data.projectId}`);

	type Tab = { href: string; label: string };

	const tabs = $derived<Tab[]>([
		...(data.role === 'SUBMITTER'
			? [
					{ href: `${base}/submit`, label: 'Submit' },
					{ href: `${base}/submissions`, label: 'My submissions' }
				]
			: [
					{ href: `${base}/submissions`, label: 'Submissions' },
					{ href: `${base}/members`, label: 'Members' },
					{ href: `${base}/invite-links`, label: 'Invite links' },
					{ href: `${base}/fields`, label: 'Form fields' }
				])
	]);
</script>

<div class="min-h-screen">
	<div class="bg-base-200 border-b border-base-300 px-6 py-4">
		<a href="/dashboard" class="text-sm text-base-content/50 hover:text-base-content mb-1 inline-block">
			← Dashboard
		</a>
		<h1 class="text-xl font-bold">{data.projectName}</h1>
		<div class="tabs tabs-bordered mt-3">
			{#each tabs as tab (tab.href)}
				<a
					href={tab.href}
					class="tab {page.url.pathname === tab.href ? 'tab-active' : ''}"
				>
					{tab.label}
				</a>
			{/each}
		</div>
	</div>

	<div class="p-6">
		{@render children()}
	</div>
</div>
