<script lang="ts">
	import type { FormField, FieldType } from '$lib/api-types';
	import { api, ApiError } from '$lib/client/api';

	let { projectId, fields: initialFields = [] }: {
		projectId: string;
		fields?: FormField[];
	} = $props();

	let fields = $state<FormField[]>([...initialFields]);

	// ── Add-field form state ─────────────────────────────────────────────────
	let newLabel = $state('');
	let newType = $state<FieldType>('TEXT');
	let newRequired = $state(false);
	let newOptions = $state(''); // comma-separated string
	let addError = $state('');
	let adding = $state(false);

	const showOptionsInput = $derived(newType === 'SELECT');

	// ── Add field ────────────────────────────────────────────────────────────

	async function addField() {
		const label = newLabel.trim();
		if (!label) {
			addError = 'Label is required';
			return;
		}

		if (newType === 'SELECT') {
			const opts = newOptions.split(',').map((o) => o.trim()).filter(Boolean);
			if (opts.length === 0) {
				addError = 'SELECT fields require at least one option';
				return;
			}
		}

		addError = '';
		adding = true;
		try {
			const options =
				newType === 'SELECT'
					? newOptions.split(',').map((o) => o.trim()).filter(Boolean)
					: null;

			const { field } = await api.fields.create(projectId, {
				label,
				type: newType,
				options,
				required: newRequired,
				sortOrder: fields.length
			});

			fields = [...fields, field];
			newLabel = '';
			newOptions = '';
			newRequired = false;
		} catch (err) {
			addError = err instanceof ApiError ? err.message : 'Failed to add field';
		}
		adding = false;
	}

	// ── Delete field ─────────────────────────────────────────────────────────

	async function deleteField(id: string) {
		const prev = fields;
		fields = fields.filter((f) => f.id !== id);
		try {
			await api.fields.delete(projectId, id);
		} catch {
			fields = prev;
		}
	}

	// ── Reorder ──────────────────────────────────────────────────────────────

	async function moveUp(index: number) {
		if (index === 0) return;
		const next = [...fields];
		const a = { ...next[index - 1], sortOrder: index };
		const b = { ...next[index], sortOrder: index - 1 };
		next[index - 1] = b;
		next[index] = a;
		fields = next;
		try {
			await Promise.all([
				api.fields.reorder(projectId, a.id, { sortOrder: a.sortOrder }),
				api.fields.reorder(projectId, b.id, { sortOrder: b.sortOrder })
			]);
		} catch {
			fields = [...fields].reverse().map((f, i) => ({ ...f, sortOrder: i }));
		}
	}

	async function moveDown(index: number) {
		if (index >= fields.length - 1) return;
		await moveUp(index + 1);
	}
</script>

<div class="flex flex-col gap-6">
	<!-- Field list -->
	{#if fields.length > 0}
		<ul class="flex flex-col gap-2" role="list">
			{#each fields as field, i (field.id)}
				<li class="flex items-center gap-2 rounded-lg border border-base-300 bg-base-100 p-3">
					<div class="flex-1">
						<span class="font-medium">{field.label}</span>
						<span class="badge badge-ghost badge-sm ml-2">{field.type}</span>
						{#if field.required}
							<span class="badge badge-warning badge-sm ml-1">required</span>
						{/if}
						{#if field.type === 'SELECT' && field.options}
							<p class="mt-1 text-xs text-base-content/60">
								Options: {JSON.parse(field.options).join(', ')}
							</p>
						{/if}
					</div>
					<div class="flex gap-1">
						<button
							class="btn btn-ghost btn-xs"
							disabled={i === 0}
							onclick={() => moveUp(i)}
							aria-label={`Move ${field.label} up`}
						>↑</button>
						<button
							class="btn btn-ghost btn-xs"
							disabled={i === fields.length - 1}
							onclick={() => moveDown(i)}
							aria-label={`Move ${field.label} down`}
						>↓</button>
						<button
							class="btn btn-ghost btn-xs text-error"
							onclick={() => deleteField(field.id)}
							aria-label={`Delete ${field.label}`}
						>✕</button>
					</div>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-base-content/50 text-sm">No fields yet. Add your first field below.</p>
	{/if}

	<!-- Add field form -->
	<div class="rounded-lg border border-base-300 bg-base-200 p-4">
		<h2 class="mb-3 font-semibold">Add field</h2>

		<div class="flex flex-col gap-3">
			<label class="flex flex-col gap-1">
				<span class="label-text text-sm">Label</span>
				<input
					type="text"
					class="input input-bordered input-sm w-full"
					bind:value={newLabel}
					aria-label="Field label"
					placeholder="e.g. Full name"
				/>
			</label>

			<label class="flex flex-col gap-1">
				<span class="label-text text-sm">Type</span>
				<select
					class="select select-bordered select-sm w-full"
					bind:value={newType}
					aria-label="Field type"
				>
					<option value="TEXT">Text</option>
					<option value="SELECT">Select</option>
					<option value="FILE">File</option>
					<option value="DATE">Date</option>
				</select>
			</label>

			{#if showOptionsInput}
				<label class="flex flex-col gap-1">
					<span class="label-text text-sm">Options (comma-separated)</span>
					<input
						type="text"
						class="input input-bordered input-sm w-full"
						bind:value={newOptions}
						aria-label="Options"
						placeholder="e.g. Option A, Option B"
					/>
				</label>
			{/if}

			<label class="flex cursor-pointer items-center gap-2">
				<input
					type="checkbox"
					class="checkbox checkbox-sm"
					bind:checked={newRequired}
					aria-label="Required"
				/>
				<span class="label-text text-sm">Required</span>
			</label>

			{#if addError}
				<p role="alert" class="text-sm text-error">{addError}</p>
			{/if}

			<button
				class="btn btn-primary btn-sm self-start"
				onclick={addField}
				disabled={adding}
			>
				{adding ? 'Adding…' : 'Add field'}
			</button>
		</div>
	</div>
</div>
