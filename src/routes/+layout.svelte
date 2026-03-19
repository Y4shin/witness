<script lang="ts">
	import { page } from '$app/state';
	import { locales, localizeHref, getLocale, setLocale } from '$lib/paraglide/runtime';
	import * as m from '$lib/paraglide/messages';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children, data } = $props();

	const isAdminRoute = $derived(page.url.pathname.startsWith('/admin'));
	const isAuthRoute = $derived(page.url.pathname.startsWith('/auth') || page.url.pathname.startsWith('/invite'));
	const currentLocale = $derived(getLocale());
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

{#if !isAdminRoute && !isAuthRoute && data.userId}
	<nav class="navbar bg-base-200 border-b border-base-300 px-4 min-h-12">
		<div class="flex-1">
			<a href="/dashboard" class="text-base font-semibold tracking-tight">Reporting Tool</a>
		</div>
		<div class="flex-none gap-2">
			<a href="/link-device" class="btn btn-ghost btn-xs">{m.nav_link_device()}</a>
			<div class="dropdown dropdown-end">
				<button tabindex="0" class="btn btn-ghost btn-xs uppercase">{currentLocale}</button>
				<ul class="dropdown-content menu bg-base-100 rounded-box z-10 w-28 p-1 shadow text-sm">
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

{@render children()}
