<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<div class="min-h-screen flex items-center justify-center p-4">
	<div class="card bg-base-100 shadow-xl w-full max-w-md">
		<div class="card-body">
			<h1 class="card-title text-2xl">Dashboard</h1>
			<p class="text-base-content/70">You are logged in.</p>
			<p class="text-sm font-mono text-base-content/50">User ID: {data.userId}</p>

			<div class="card-actions justify-end mt-4">
				<form method="POST" action="?/logout">
					<button class="btn btn-outline btn-sm" type="submit">Log out</button>
				</form>
			</div>
		</div>
	</div>
</div>
