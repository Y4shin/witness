<svelte:head><title>Witness</title></svelte:head>

<div class="min-h-screen flex flex-col items-center justify-center p-8 gap-10">
	<div class="text-center max-w-lg">
		<h1 class="text-4xl font-bold tracking-tight mb-4">Witness</h1>
		<p class="text-base-content/70 text-lg">
			A secure platform for collecting evidence and sources.
			All submissions are end-to-end encrypted — the server never sees your data.
		</p>
	</div>

	<div class="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl w-full text-sm">
		<div class="card bg-base-200 p-5">
			<p class="font-semibold mb-1">End-to-end encrypted</p>
			<p class="text-base-content/60">Submissions are encrypted in your browser before leaving your device.</p>
		</div>
		<div class="card bg-base-200 p-5">
			<p class="font-semibold mb-1">No account required</p>
			<p class="text-base-content/60">Access is granted via invite links. No passwords, no email sign-up.</p>
		</div>
		<div class="card bg-base-200 p-5">
			<p class="font-semibold mb-1">Your key, your data</p>
			<p class="text-base-content/60">Your private key lives only in your browser. The server cannot decrypt anything.</p>
		</div>
	</div>

	<p class="text-base-content/50 text-sm">
		To get started, open an invite link shared with you.
	</p>
</div>
