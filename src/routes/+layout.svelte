<script lang="ts">
	import { page } from '$app/state';
	import { PUBLIC_VERSION } from '$env/static/public';
	import { locales, getLocale, setLocale } from '$lib/paraglide/runtime';
	import * as m from '$lib/paraglide/messages';
	import OfflineModeBanner from '$lib/components/OfflineModeBanner.svelte';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children, data } = $props();

	const isAdminRoute = $derived(page.url.pathname.startsWith('/admin'));
	const isAuthRoute = $derived(
		page.url.pathname.startsWith('/auth') || page.url.pathname.startsWith('/invite')
	);
	const isOfflineRoute = $derived(page.url.pathname.endsWith('/offline'));
	const currentLocale = $derived(getLocale());
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

{#if !isAdminRoute && !isAuthRoute && data.memberId}
	<nav class="navbar min-h-12 border-b border-base-300 bg-base-200 px-4">
		<div class="flex-1">
			<a href="/dashboard" class="text-base font-semibold tracking-tight">Witness</a>
		</div>
		<div class="flex-none gap-2">
			<a href="/link-device" class="btn btn-ghost btn-xs">{m.nav_link_device()}</a>
			<div class="dropdown dropdown-end">
				<button tabindex="0" class="btn uppercase btn-ghost btn-xs">{currentLocale}</button>
				<ul class="dropdown-content menu z-10 w-28 rounded-box bg-base-100 p-1 text-sm shadow">
					{#each locales as locale (locale)}
						<li>
							<button
								class="justify-start {locale === currentLocale ? 'font-bold' : ''}"
								onclick={() => setLocale(locale)}
							>
								{locale === 'en' ? 'English' : 'Deutsch'}
							</button>
						</li>
					{/each}
				</ul>
			</div>
			<form method="POST" action="/dashboard?/logout">
				<button class="btn btn-ghost btn-xs">{m.nav_log_out()}</button>
			</form>
		</div>
	</nav>
{/if}

{#if !isOfflineRoute}
	<OfflineModeBanner />
{/if}

{@render children()}

{#if !isAdminRoute && !isAuthRoute && data.memberId && PUBLIC_VERSION}
	<footer class="border-t border-base-300 px-4 py-2 text-center text-xs text-base-content/40">
		v{PUBLIC_VERSION}
	</footer>
{/if}
