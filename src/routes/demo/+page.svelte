<script lang="ts">
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages';
</script>

<a href={resolve('/demo/paraglide')}>{m.demo_paraglide_link()}</a>
<a href={resolve('/demo/playwright')}>{m.demo_playwright_link()}</a>
