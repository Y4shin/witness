<script lang="ts">
	import * as m from '$lib/paraglide/messages';

	let inviteInput = $state('');
	let inviteError = $state('');

	function extractToken(raw: string): string | null {
		const trimmed = raw.trim();
		if (!trimmed) return null;
		// Full URL or path — find /invite/<token>
		const match = trimmed.match(/\/invite\/([^/?#\s]+)/);
		if (match) return match[1];
		// Bare token (no slashes)
		if (!trimmed.includes('/')) return trimmed;
		return null;
	}

	function goToInvite() {
		const token = extractToken(inviteInput);
		if (!token) {
			inviteError = m.landing_invalid_invite();
			return;
		}
		window.location.href = `/invite/${token}`;
	}
</script>

<svelte:head><title>Witness</title></svelte:head>

<div class="min-h-screen flex flex-col items-center justify-center p-8 gap-10">
	<div class="text-center max-w-lg">
		<h1 class="text-4xl font-bold tracking-tight mb-4">Witness</h1>
		<p class="text-base-content/70 text-lg">
			{m.landing_tagline()}
		</p>
	</div>

	<div class="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl w-full text-sm">
		<div class="card bg-base-200 p-5">
			<p class="font-semibold mb-1">{m.landing_e2e_heading()}</p>
			<p class="text-base-content/60">{m.landing_e2e_body()}</p>
		</div>
		<div class="card bg-base-200 p-5">
			<p class="font-semibold mb-1">{m.landing_no_account_heading()}</p>
			<p class="text-base-content/60">{m.landing_no_account_body()}</p>
		</div>
		<div class="card bg-base-200 p-5">
			<p class="font-semibold mb-1">{m.landing_your_key_heading()}</p>
			<p class="text-base-content/60">{m.landing_your_key_body()}</p>
		</div>
	</div>

	<div class="card bg-base-100 shadow w-full max-w-md">
		<div class="card-body gap-3">
			<p class="font-semibold">{m.landing_join_heading()}</p>
			<p class="text-sm text-base-content/60">{m.landing_join_subtext()}</p>
			<div class="flex gap-2">
				<input
					type="text"
					class="input input-bordered flex-1 text-sm"
					placeholder={m.landing_join_placeholder()}
					bind:value={inviteInput}
					oninput={() => (inviteError = '')}
					onkeydown={(e) => { if (e.key === 'Enter') goToInvite(); }}
				/>
				<button class="btn btn-primary btn-sm self-center" onclick={goToInvite}>{m.landing_join_btn()}</button>
			</div>
			{#if inviteError}
				<p class="text-error text-sm">{inviteError}</p>
			{/if}
		</div>
	</div>
</div>
