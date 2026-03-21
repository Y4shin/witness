<script lang="ts">
	import { page } from '$app/state';
	import type { LayoutData } from './$types';
	import * as m from '$lib/paraglide/messages';

	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();

	const base = $derived(`/projects/${data.projectId}`);

	type Tab = { href: string; label: string };

	const tabs = $derived<Tab[]>(
		data.role === 'SUBMITTER'
			? [
					{ href: `${base}/submit`, label: m.layout_tab_submit() },
					{ href: `${base}/submissions`, label: m.layout_tab_my_submissions() }
				]
			: [
					{ href: `${base}/submit`, label: m.layout_tab_submit() },
					{ href: `${base}/submissions`, label: m.layout_tab_submissions() },
					{ href: `${base}/members`, label: m.layout_tab_members() },
					{ href: `${base}/invite-links`, label: m.layout_tab_invite_links() },
					{ href: `${base}/fields`, label: m.layout_tab_form_fields() }
				]
	);
</script>

<div class="min-h-screen">
	<div class="bg-base-200 border-b border-base-300 px-6 py-4">
		<a href="/dashboard" class="text-sm text-base-content/50 hover:text-base-content mb-1 inline-block">
			{m.layout_back_dashboard()}
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
