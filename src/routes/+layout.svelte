<script lang="ts">
	import { page } from '$app/state';
	import { locales, localizeHref } from '$lib/paraglide/runtime';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children, data } = $props();

	const isAdminRoute = $derived(page.url.pathname.startsWith('/admin'));
	const isAuthRoute = $derived(page.url.pathname.startsWith('/auth') || page.url.pathname.startsWith('/invite'));
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

{#if !isAdminRoute && !isAuthRoute && data.userId}
	<nav class="navbar bg-base-200 border-b border-base-300 px-4 min-h-12">
		<div class="flex-1">
			<a href="/dashboard" class="text-base font-semibold tracking-tight">Reporting Tool</a>
		</div>
		<div class="flex-none gap-2">
			<a href="/link-device" class="btn btn-ghost btn-xs">Link device</a>
			<form method="POST" action="/dashboard?/logout">
				<button class="btn btn-ghost btn-xs">Log out</button>
			</form>
		</div>
	</nav>
{/if}

{@render children()}

<div style="display:none">
	{#each locales as locale (locale)}
		<a href={localizeHref(page.url.pathname, { locale })}>{locale}</a>
	{/each}
</div>
