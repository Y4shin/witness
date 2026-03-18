<script lang="ts">
	import type { FormField } from '$lib/api-types';

	let {
		fields,
		onsubmit,
		error = '',
		disabled = false
	}: {
		fields: FormField[];
		onsubmit: (data: Record<string, string>) => Promise<void>;
		error?: string;
		disabled?: boolean;
	} = $props();

	let formData = $state<Record<string, string>>(
		Object.fromEntries(fields.map((f) => [f.id, '']))
	);
	let submitting = $state(false);

	const allRequiredFilled = $derived(
		fields
			.filter((f) => f.required)
			.every((f) => formData[f.id]?.trim())
	);

	async function handleSubmit() {
		if (!allRequiredFilled || submitting || disabled) return;
		submitting = true;
		try {
			await onsubmit(formData);
		} finally {
			submitting = false;
		}
	}
</script>

<form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }} class="flex flex-col gap-4">
	{#each fields as field (field.id)}
		<label class="flex flex-col gap-1">
			<span class="label-text font-medium">
				{field.label}
				{#if field.required}
					<span class="text-error" aria-hidden="true">*</span>
				{/if}
			</span>

			{#if field.type === 'TEXT'}
				<input
					type="text"
					class="input input-bordered w-full"
					bind:value={formData[field.id]}
					aria-label={field.label}
					aria-required={field.required}
					{disabled}
				/>

			{:else if field.type === 'SELECT'}
				<select
					class="select select-bordered w-full"
					bind:value={formData[field.id]}
					aria-label={field.label}
					aria-required={field.required}
					{disabled}
				>
					<option value="">— select —</option>
					{#each JSON.parse(field.options ?? '[]') as opt (opt)}
						<option value={opt}>{opt}</option>
					{/each}
				</select>

			{:else if field.type === 'FILE'}
				<input
					type="file"
					class="file-input file-input-bordered w-full"
					aria-label={field.label}
					aria-required={field.required}
					{disabled}
				/>
			{/if}
		</label>
	{/each}

	{#if error}
		<p role="alert" class="text-sm text-error">{error}</p>
	{/if}

	<button
		type="submit"
		class="btn btn-primary"
		disabled={!allRequiredFilled || submitting || disabled}
	>
		{submitting ? 'Submitting…' : 'Submit'}
	</button>
</form>
