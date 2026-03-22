<script lang="ts">
	import { onMount } from 'svelte';
	import type { LayoutData } from '../$types';
	import * as m from '$lib/paraglide/messages';
	import { loadOfflineFileSettings, saveOfflineFileSettings } from '$lib/client/offline-settings';
	import { getCachedFileSizeMb, clearFileCache } from '$lib/client/file-cache';
	import type { SubmissionType } from '$lib/api-types';

	let { data }: { data: LayoutData } = $props();

	const ALL_TYPES: SubmissionType[] = ['WEBPAGE', 'YOUTUBE_VIDEO', 'INSTAGRAM_POST', 'INSTAGRAM_STORY'];
	const MAX_SIZE_OPTIONS = [
		{ label: '50 MB', value: 50 },
		{ label: '100 MB', value: 100 },
		{ label: '200 MB', value: 200 },
		{ label: '500 MB', value: 500 },
		{ label: m.settings_no_limit(), value: 0 }
	];

	let enabled = $state(false);
	let maxCacheMb = $state(200);
	let allowedTypes = $state<SubmissionType[]>([]);
	let usedMb = $state(0);
	let cleared = $state(false);

	onMount(async () => {
		const s = loadOfflineFileSettings(data.projectId);
		enabled = s.enabled;
		maxCacheMb = s.maxCacheMb;
		allowedTypes = s.allowedTypes;
		usedMb = await getCachedFileSizeMb();
	});

	function save() {
		saveOfflineFileSettings(data.projectId, { enabled, maxCacheMb, allowedTypes });
	}

	function toggleType(type: SubmissionType) {
		if (allowedTypes.includes(type)) {
			allowedTypes = allowedTypes.filter((t) => t !== type);
		} else {
			allowedTypes = [...allowedTypes, type];
		}
		save();
	}

	async function handleClear() {
		await clearFileCache();
		usedMb = 0;
		cleared = true;
		setTimeout(() => (cleared = false), 3000);
	}
</script>

<svelte:head><title>Witness – {m.layout_tab_settings()}</title></svelte:head>

<div class="max-w-xl flex flex-col gap-6">
	<h2 class="text-lg font-semibold">{m.settings_offline_files_title()}</h2>

	<!-- Enable toggle -->
	<label class="flex items-center gap-3 cursor-pointer">
		<input
			type="checkbox"
			class="toggle toggle-primary"
			bind:checked={enabled}
			onchange={save}
		/>
		<span>{m.settings_offline_files_enable()}</span>
	</label>

	{#if enabled}
		<!-- Max cache size -->
		<div class="flex flex-col gap-2">
			<span class="text-sm font-medium">{m.settings_offline_files_max_size()}</span>
			<select class="select select-bordered w-full max-w-xs" bind:value={maxCacheMb} onchange={save}>
				{#each MAX_SIZE_OPTIONS as opt (opt.value)}
					<option value={opt.value}>{opt.label}</option>
				{/each}
			</select>
		</div>

		<!-- Allowed types -->
		<div class="flex flex-col gap-2">
			<span class="text-sm font-medium">{m.settings_offline_files_types()}</span>
			<div class="flex flex-col gap-2">
				{#each ALL_TYPES as type (type)}
					<label class="flex items-center gap-2 cursor-pointer">
						<input
							type="checkbox"
							class="checkbox checkbox-primary"
							checked={allowedTypes.includes(type)}
							onchange={() => toggleType(type)}
						/>
						<span class="text-sm">{type}</span>
					</label>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Cache usage + clear -->
	<div class="flex items-center gap-4">
		<span class="text-sm text-base-content/60">
			{m.settings_offline_files_usage({ mb: usedMb.toFixed(1) })}
		</span>
		<button class="btn btn-sm btn-outline btn-error" onclick={handleClear}>
			{m.settings_offline_files_clear()}
		</button>
		{#if cleared}
			<span class="text-sm text-success">{m.settings_offline_files_cleared()}</span>
		{/if}
	</div>
</div>
