<script lang="ts">
	import { SUBMISSION_TYPES, getTypeDef } from '$lib/submission-types';
	import type { SubmissionType, FormField } from '$lib/api-types';
	import * as m from '$lib/paraglide/messages';

	interface Props {
		formFields?: FormField[];
		onsubmit: (data: {
			type: SubmissionType;
			fields: Record<string, string>;
			archiveCandidateUrl: string | null;
			files: File[];
		}) => Promise<void>;
		error?: string;
	}

	let { onsubmit, error = '', formFields = [] }: Props = $props();

	let selectedType = $state<SubmissionType>('WEBPAGE');
	let fieldValues = $state<Record<string, string>>({});
	let pendingFiles = $state<File[]>([]);
	let submitting = $state(false);
	let fileInputEl = $state<HTMLInputElement | null>(null);

	const typeDef = $derived(getTypeDef(selectedType));

	// Reset type-specific field values when type changes
	$effect(() => {
		selectedType;
		fieldValues = {};
	});

	// Initialise DATE fields to today's date when form fields are available
	$effect(() => {
		const today = new Date().toISOString().slice(0, 10);
		for (const f of formFields) {
			if (f.type === 'DATE' && !fieldValues[`custom_${f.id}`]) {
				fieldValues[`custom_${f.id}`] = today;
			}
		}
	});

	function handleFileChange(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files) {
			pendingFiles = [...pendingFiles, ...Array.from(input.files)];
			input.value = '';
		}
	}

	function removeFile(index: number) {
		pendingFiles = pendingFiles.filter((_, i) => i !== index);
	}

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		submitting = true;
		try {
			const archiveField = typeDef.fields.find((f) => f.isArchiveUrl);
			const archiveCandidateUrl = archiveField ? (fieldValues[archiveField.key] ?? null) : null;
			await onsubmit({
				type: selectedType,
				fields: { ...fieldValues },
				archiveCandidateUrl: archiveCandidateUrl || null,
				files: [...pendingFiles]
			});
		} finally {
			submitting = false;
		}
	}
</script>

<form class="flex flex-col gap-4" onsubmit={handleSubmit}>
	<!-- Type selector -->
	<label class="flex flex-col gap-1">
		<span class="label-text font-medium">{m.submit_type_label()}</span>
		<select class="select select-bordered" bind:value={selectedType} aria-label={m.submit_type_label()}>
			{#each SUBMISSION_TYPES as t (t.value)}
				<option value={t.value}>{t.label}</option>
			{/each}
		</select>
	</label>

	<!-- Type-specific fields -->
	{#each typeDef.fields as field (field.key)}
		<label class="flex flex-col gap-1">
			<span class="label-text font-medium">
				{field.label}
				{#if !field.required}<span class="text-base-content/50 text-xs">{m.submit_optional()}</span>{/if}
			</span>
			{#if field.key === 'notes'}
				<textarea
					class="textarea textarea-bordered"
					placeholder={field.placeholder}
					bind:value={fieldValues[field.key]}
					aria-label={field.label}
					rows={3}
				></textarea>
			{:else}
				<input
					type="text"
					class="input input-bordered"
					placeholder={field.placeholder}
					bind:value={fieldValues[field.key]}
					required={field.required}
					aria-label={field.label}
				/>
			{/if}
		</label>
	{/each}

	<!-- Custom project fields (TEXT and SELECT) -->
	{#each formFields.filter(f => f.type !== 'FILE') as field (field.id)}
		<label class="flex flex-col gap-1">
			<span class="label-text font-medium">
				{field.label}
				{#if !field.required}<span class="text-base-content/50 text-xs">{m.submit_optional()}</span>{/if}
			</span>
			{#if field.type === 'SELECT'}
				<select
					class="select select-bordered"
					bind:value={fieldValues[`custom_${field.id}`]}
					required={field.required}
					aria-label={field.label}
				>
					<option value="">{m.submit_select_placeholder()}</option>
					{#each (JSON.parse(field.options ?? '[]') as string[]) as opt (opt)}
						<option value={opt}>{opt}</option>
					{/each}
				</select>
			{:else if field.type === 'DATE'}
				<input
					type="date"
					class="input input-bordered"
					bind:value={fieldValues[`custom_${field.id}`]}
					required={field.required}
					aria-label={field.label}
				/>
			{:else}
				<input
					type="text"
					class="input input-bordered"
					bind:value={fieldValues[`custom_${field.id}`]}
					required={field.required}
					aria-label={field.label}
				/>
			{/if}
		</label>
	{/each}

	<!-- File uploads -->
	<div class="flex flex-col gap-2">
		<span class="label-text font-medium">{m.submit_files_label()}</span>
		{#if pendingFiles.length > 0}
			<ul class="flex flex-col gap-1">
				{#each pendingFiles as file, i (i)}
					<li class="flex items-center justify-between bg-base-200 rounded px-3 py-1 text-sm">
						<span class="truncate max-w-xs opacity-80">{file.name}</span>
						<button
							type="button"
							class="btn btn-xs btn-ghost text-error ml-2"
							onclick={() => removeFile(i)}
							aria-label={`Remove ${file.name}`}
						>✕</button>
					</li>
				{/each}
			</ul>
		{/if}
		<input
			bind:this={fileInputEl}
			type="file"
			multiple
			accept="image/*,video/*,application/pdf"
			class="file-input file-input-bordered file-input-sm"
			onchange={handleFileChange}
			aria-label={m.submit_files_attach_label()}
		/>
	</div>

	{#if error}
		<div role="alert" class="alert alert-error text-sm">
			<span>{error}</span>
		</div>
	{/if}

	<button
		type="submit"
		class="btn btn-primary"
		disabled={submitting}
		data-testid="submit-btn"
	>
		{#if submitting}
			<span class="loading loading-spinner loading-sm"></span>
			{m.submit_submitting()}
		{:else}
			{m.submit_btn()}
		{/if}
	</button>
</form>
