<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import type { LayoutData } from './$types';
	import * as m from '$lib/paraglide/messages';
	import { loadMembershipForProject } from '$lib/client/key-store';
	import { importUserKeyBundleJwk } from '$lib/crypto';
	import { countPending } from '$lib/client/queue';
	import { syncPendingSubmissions } from '$lib/client/sync';
	import SyncStatusBar from '$lib/components/SyncStatusBar.svelte';

	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();

	const base = $derived(`/projects/${data.projectId}`);

	let pendingCount = $state(0);
	let syncing = $state(false);
	let signingKey: CryptoKey | null = null;

	async function runSync() {
		if (syncing || !signingKey || !navigator.onLine) return;
		syncing = true;
		try {
			await syncPendingSubmissions(signingKey);
		} finally {
			pendingCount = await countPending();
			syncing = false;
		}
	}

	function handleOnline() {
		if (pendingCount > 0) runSync();
	}

	onMount(async () => {
		const membership = loadMembershipForProject(data.projectId);
		if (membership) {
			const bundle = await importUserKeyBundleJwk(membership.bundle);
			signingKey = bundle.signing.privateKey;
		}
		pendingCount = await countPending();
		if (navigator.onLine && pendingCount > 0) runSync();
		window.addEventListener('online', handleOnline);
	});

	onDestroy(() => {
		window.removeEventListener('online', handleOnline);
	});

	type Tab = { href: string; label: string };

	const tabs = $derived<Tab[]>(
		data.role === 'SUBMITTER'
			? [
					{ href: `${base}/submit`, label: m.layout_tab_submit() },
					{ href: `${base}/submissions`, label: m.layout_tab_my_submissions() },
					{ href: `${base}/settings`, label: m.layout_tab_settings() }
				]
			: [
					{ href: `${base}/submit`, label: m.layout_tab_submit() },
					{ href: `${base}/submissions`, label: m.layout_tab_submissions() },
					{ href: `${base}/members`, label: m.layout_tab_members() },
					{ href: `${base}/invite-links`, label: m.layout_tab_invite_links() },
					{ href: `${base}/fields`, label: m.layout_tab_form_fields() },
					{ href: `${base}/settings`, label: m.layout_tab_settings() }
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

	<SyncStatusBar {pendingCount} {syncing} onSyncRequest={runSync} />

	<div class="p-6">
		{@render children()}
	</div>
</div>
