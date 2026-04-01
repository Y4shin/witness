<script lang="ts">
	import { browser } from '$app/environment';
	import * as m from '$lib/paraglide/messages';
	import { onMount } from 'svelte';

	const OFFLINE_SESSION_KEY = 'rt:offline-mode';

	function readStoredOfflineState() {
		if (!browser) return false;
		try {
			return sessionStorage.getItem(OFFLINE_SESSION_KEY) === '1';
		} catch {
			return false;
		}
	}

	function writeStoredOfflineState(isOffline: boolean) {
		if (!browser) return;
		try {
			if (isOffline) {
				sessionStorage.setItem(OFFLINE_SESSION_KEY, '1');
			} else {
				sessionStorage.removeItem(OFFLINE_SESSION_KEY);
			}
		} catch {
			// Ignore storage failures; the live in-memory state still updates.
		}
	}

	let isOnline = $state(browser ? navigator.onLine && !readStoredOfflineState() : true);

	onMount(() => {
		isOnline = navigator.onLine && !readStoredOfflineState();

		const setOnline = () => {
			writeStoredOfflineState(false);
			isOnline = true;
		};
		const setOffline = () => {
			writeStoredOfflineState(true);
			isOnline = false;
		};
		const handleWorkerMessage = (event: MessageEvent<{ type?: string }>) => {
			if (event.data?.type === 'offline-navigation') {
				writeStoredOfflineState(true);
				isOnline = false;
			}

			if (event.data?.type === 'online-navigation') {
				writeStoredOfflineState(false);
				isOnline = true;
			}
		};

		window.addEventListener('online', setOnline);
		window.addEventListener('offline', setOffline);
		navigator.serviceWorker?.addEventListener('message', handleWorkerMessage);

		return () => {
			window.removeEventListener('online', setOnline);
			window.removeEventListener('offline', setOffline);
			navigator.serviceWorker?.removeEventListener('message', handleWorkerMessage);
		};
	});
</script>

{#if !isOnline}
	<div
		role="status"
		aria-live="polite"
		class="alert rounded-none border-x-0 border-t-0 border-base-300/60 px-4 py-2 text-sm alert-warning"
	>
		<span>{m.offline_mode_banner()}</span>
	</div>
{/if}
