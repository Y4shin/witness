<script lang="ts">
	interface Props {
		onsubmit: (data: { name: string; contact: string }) => void;
		disabled?: boolean;
		error?: string;
	}

	let { onsubmit, disabled = false, error = '' }: Props = $props();

	let name = $state('');
	let contact = $state('');

	const canSubmit = $derived(name.trim().length > 0 && contact.trim().length > 0 && !disabled);

	function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (!canSubmit) return;
		onsubmit({ name: name.trim(), contact: contact.trim() });
	}
</script>

<form onsubmit={handleSubmit} class="flex flex-col gap-4">
	<label class="form-control">
		<span class="label-text mb-1">Name</span>
		<input
			class="input input-bordered"
			type="text"
			bind:value={name}
			placeholder="Your name"
			required
			aria-label="Name"
		/>
	</label>

	<label class="form-control">
		<span class="label-text mb-1">Contact</span>
		<input
			class="input input-bordered"
			type="text"
			bind:value={contact}
			placeholder="Email or other contact info"
			required
			aria-label="Contact"
		/>
	</label>

	{#if error}
		<p role="alert" class="text-error text-sm">{error}</p>
	{/if}

	<button class="btn btn-primary" type="submit" disabled={!canSubmit}>
		{disabled ? 'Registering…' : 'Register'}
	</button>
</form>
