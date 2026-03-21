<script lang="ts">
	import * as m from '$lib/paraglide/messages';

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
		<span class="label-text mb-1">{m.auth_name_label()}</span>
		<input
			class="input input-bordered"
			type="text"
			bind:value={name}
			placeholder={m.auth_name_placeholder()}
			required
			aria-label={m.auth_name_label()}
		/>
	</label>

	<label class="form-control">
		<span class="label-text mb-1">{m.auth_contact_label()}</span>
		<input
			class="input input-bordered"
			type="text"
			bind:value={contact}
			placeholder={m.auth_contact_placeholder()}
			required
			aria-label={m.auth_contact_label()}
		/>
	</label>

	{#if error}
		<p role="alert" class="text-error text-sm">{error}</p>
	{/if}

	<button class="btn btn-primary" type="submit" disabled={!canSubmit}>
		{disabled ? m.auth_registering() : m.auth_register_btn()}
	</button>
</form>
