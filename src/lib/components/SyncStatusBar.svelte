<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '$lib/paraglide/messages';

	interface Props {
		pendingCount: number;
		syncing: boolean;
		onSyncRequest: () => void;
	}

	let { pendingCount, syncing, onSyncRequest }: Props = $props();

	let isOnline = $state(true);

	onMount(() => {
		isOnline = navigator.onLine;
		const setOnline = () => (isOnline = true);
		const setOffline = () => (isOnline = false);
		window.addEventListener('online', setOnline);
		window.addEventListener('offline', setOffline);
		return () => {
			window.removeEventListener('online', setOnline);
			window.removeEventListener('offline', setOffline);
		};
	});
</script>

{#if pendingCount > 0 || syncing}
	<div role="status" class="alert alert-warning rounded-none py-2 text-sm flex items-center gap-3">
		<span class="flex-1">
			{#if syncing}
				{m.sync_syncing()}
			{:else}
				{m.sync_pending_count({ count: pendingCount })}
			{/if}
		</span>
		{#if syncing}
			<span class="loading loading-spinner loading-sm"></span>
		{:else}
			<button
				class="btn btn-xs btn-neutral"
				disabled={!isOnline}
				onclick={onSyncRequest}
			>
				{isOnline ? m.sync_now_btn() : m.sync_offline_disabled()}
			</button>
		{/if}
	</div>
{/if}
