<script lang="ts">
	import { onMount } from 'svelte';
	import {
		decryptSymmetricKey,
		decryptSymmetric,
		importEcdhPrivateKey,
		importUserKeyBundleJwk
	} from '$lib/crypto';
	import { loadMembershipForProject } from '$lib/client/key-store';
	import { api, ApiError } from '$lib/client/api';
	import { openCacheDb, initCacheKey, readCacheEntry, writeCacheEntry } from '$lib/stores/cache';
	import { SUBMISSION_TYPE_LABELS } from '$lib/submission-types';
	import {
		buildSubmissionIndex,
		searchSubmissions
	} from '$lib/stores/submissions-search';
	import {
		sortSubmissionIds,
		paginateIds,
		totalPages as calcTotalPages,
		extractContentDate
	} from '$lib/stores/submissions-utils';
	import type { AnyOrama } from '@orama/orama';
	import type { EncryptedKey } from '$lib/crypto/asymmetric';
	import { SvelteSet } from 'svelte/reactivity';
	import type { SubmissionType, FormField } from '$lib/api-types';
	import type { PageData } from './$types';
	import * as m from '$lib/paraglide/messages';

	let { data }: { data: PageData } = $props();

	// ── Types ──────────────────────────────────────────────────────────────────

	type DecryptedSubmission = {
		id: string;
		memberId: string;
		createdAt: string;
		type: SubmissionType;
		archiveUrl: string | null;
		fileCount: number;
		contentDate: string | null; // ISO date from a DATE-type form field, or null
		fields: Record<string, string>;
		decryptError?: string;
	};

	type PageMode = 'loading' | 'cached' | 'ready' | 'error';
	type SortField = 'submittedAt' | 'contentDate' | 'type' | 'fileCount' | string;

	// ── Page state ─────────────────────────────────────────────────────────────

	let mode = $state<PageMode>('loading');
	let pageError = $state('');
	let submissions = $state<DecryptedSubmission[]>([]);
	let formFields = $state<FormField[]>([]);
	let refreshing = $state(false);
	let searchIndex = $state<AnyOrama | null>(null);

	// ── Filter state ───────────────────────────────────────────────────────────

	let textQuery = $state('');
	let textColumns = new SvelteSet<string>();
	let typeFilter = new SvelteSet<string>();
	let submittedFrom = $state('');
	let submittedTo = $state('');
	let contentFrom = $state('');
	let contentTo = $state('');
	let hasFilesOnly = $state(false);
	let hasArchiveOnly = $state(false);
	let selectFilters = $state<Record<string, Set<string>>>({});
	let filtersOpen = $state(false);

	// ── Sort state ─────────────────────────────────────────────────────────────

	let sortField = $state<SortField>('submittedAt');
	let sortDir = $state<'ASC' | 'DESC'>('DESC');

	// ── Pagination ─────────────────────────────────────────────────────────────

	const PAGE_SIZE = 25;
	let currentPage = $state(1);

	// ── Derived helpers ────────────────────────────────────────────────────────

	const selectFormFields = $derived(formFields.filter((f) => f.type === 'SELECT'));
	const textFormFields   = $derived(formFields.filter((f) => f.type === 'TEXT'));
	const dateFormFields   = $derived(formFields.filter((f) => f.type === 'DATE'));
	const hasContentDates  = $derived(submissions.some((s) => s.contentDate !== null));

	const activeFilterCount = $derived.by(() => {
		let n = 0;
		if (typeFilter.size > 0) n++;
		if (submittedFrom || submittedTo) n++;
		if (contentFrom || contentTo) n++;
		if (hasFilesOnly) n++;
		if (hasArchiveOnly) n++;
		for (const v of Object.values(selectFilters)) if (v.size > 0) n++;
		return n;
	});

	// Sort options: fixed fields + one per TEXT form field
	const sortOptions = $derived([
		{ value: 'submittedAt', label: 'Submitted date' },
		...(hasContentDates ? [{ value: 'contentDate', label: 'Content date' }] : []),
		{ value: 'type',      label: 'Type' },
		{ value: 'fileCount', label: 'Files' },
		...textFormFields.map((f) => ({ value: `custom_${f.id}`, label: f.label }))
	]);

	// ── Filtered + sorted IDs (reactive) ──────────────────────────────────────

	let filteredSortedIds = $state<string[]>([]);

	$effect(() => {
		// Capture all reactive dependencies
		const params = {
			textQuery,
			textColumns,
			typeFilter,
			submittedFrom,
			submittedTo,
			contentFrom,
			contentTo,
			hasFilesOnly,
			hasArchiveOnly,
			selectFilters
		};
		const subs = submissions;
		const idx = searchIndex;
		const sf = sortField;
		const sd = sortDir;

		const hasAnyFilter =
			params.textQuery.trim() !== '' ||
			params.typeFilter.size > 0 ||
			params.submittedFrom !== '' ||
			params.submittedTo !== '' ||
			params.contentFrom !== '' ||
			params.contentTo !== '' ||
			params.hasFilesOnly ||
			params.hasArchiveOnly ||
			Object.values(params.selectFilters).some((v) => v.size > 0);

		(async () => {
			let ids: string[];

			if (idx && hasAnyFilter) {
				ids = await searchSubmissions(idx, params);
			} else {
				ids = subs.map((s) => s.id);
			}

			// Client-side sort
			const subMap = new Map(subs.map((s) => [s.id, s]));
			ids = sortSubmissionIds(ids, subMap, sf, sd);

			filteredSortedIds = ids;
			currentPage = 1;
		})();
	});

	// ── Pagination derived ─────────────────────────────────────────────────────

	const totalPages = $derived(calcTotalPages(filteredSortedIds.length, PAGE_SIZE));
	const visibleSubs = $derived.by(() => {
		const pageIds = paginateIds(filteredSortedIds, currentPage, PAGE_SIZE);
		return pageIds
			.map((id) => submissions.find((s) => s.id === id))
			.filter((s): s is DecryptedSubmission => s !== undefined);
	});

	// ── Cache key ─────────────────────────────────────────────────────────────

	const CACHE_KEY = `submissions:${data.projectId}`;

	// ── Mount: load + decrypt ─────────────────────────────────────────────────

	onMount(async () => {
		const membership = loadMembershipForProject(data.projectId);
		if (!membership) {
			window.location.href = `/auth?projectId=${data.projectId}&next=/projects/${data.projectId}/submissions`;
			return;
		}

		try {
			const userBundle = await importUserKeyBundleJwk(membership.bundle);

			const [cacheDb, cacheKey] = await Promise.all([
				openCacheDb(),
				initCacheKey(userBundle.encryption.privateKey)
			]);

			// Show cached submissions immediately if available
			try {
				const cached = await readCacheEntry<DecryptedSubmission[]>(cacheDb, cacheKey, CACHE_KEY);
				if (cached && cached.length > 0) {
					submissions = cached;
					mode = 'cached';
				}
			} catch {
				// Cache miss — continue to fetch fresh
			}

			refreshing = mode === 'cached';

			// Decrypt project private key (moderators only)
			let projectPrivateKey: CryptoKey | null = null;
			if (data.role === 'MODERATOR' && data.encryptedProjectPrivateKey) {
				const encProjKey = JSON.parse(data.encryptedProjectPrivateKey) as {
					payload: string;
					key: EncryptedKey;
				};
				const symKey = await decryptSymmetricKey(encProjKey.key, userBundle.encryption.privateKey);
				const pkcs8 = await decryptSymmetric(symKey, encProjKey.payload);
				projectPrivateKey = await importEcdhPrivateKey(pkcs8);
			}

			// Fetch submissions + form fields in parallel (fields are non-fatal)
			const [{ submissions: raw }, fieldsResult] = await Promise.all([
				api.submissions.list(data.projectId),
				api.fields.list(data.projectId).catch(() => ({ fields: [] as typeof formFields }))
			]);
			const fields = fieldsResult.fields;

			formFields = fields;

			// Identify DATE fields for contentDate extraction
			const dateFieldIds = new Set(fields.filter((f) => f.type === 'DATE').map((f) => f.id));

			const fresh = await Promise.all(
				raw.map(async (s) => {
					try {
						let symKey: CryptoKey;
						if (data.role === 'MODERATOR' && projectPrivateKey) {
							const encKeyProject = JSON.parse(s.encryptedKeyProject) as EncryptedKey;
							symKey = await decryptSymmetricKey(encKeyProject, projectPrivateKey);
						} else {
							const encKeyUser = JSON.parse(s.encryptedKeyUser) as EncryptedKey;
							symKey = await decryptSymmetricKey(encKeyUser, userBundle.encryption.privateKey);
						}
						const plaintext = await decryptSymmetric(symKey, s.encryptedPayload);
						const fields = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, string>;

						// Extract contentDate from the first DATE-type form field
						const contentDate = extractContentDate(fields, dateFieldIds);

						return {
							id: s.id,
							memberId: s.memberId,
							createdAt: s.createdAt,
							type: s.type,
							archiveUrl: s.archiveUrl,
							fileCount: s.fileCount,
							contentDate,
							fields
						} satisfies DecryptedSubmission;
					} catch {
						return {
							id: s.id,
							memberId: s.memberId,
							createdAt: s.createdAt,
							type: s.type,
							archiveUrl: s.archiveUrl,
							fileCount: s.fileCount,
							contentDate: null,
							fields: {},
							decryptError: 'Decryption failed — key may be missing or corrupted'
						} satisfies DecryptedSubmission;
					}
				})
			);

			submissions = fresh;
			mode = 'ready';

			// Build Orama index for filtering
			const selectFields = fields
				.filter((f) => f.type === 'SELECT')
				.map((f) => ({ id: f.id, type: f.type, options: f.options }));
			const textFieldDefs = fields
				.filter((f) => f.type === 'TEXT')
				.map((f) => ({ id: f.id, label: f.label }));
			searchIndex = await buildSubmissionIndex(
				fresh.map((s) => ({
					id: s.id,
					userId: s.memberId,
					createdAt: s.createdAt,
					type: s.type,
					archiveUrl: s.archiveUrl,
					fileCount: s.fileCount,
					contentDate: s.contentDate,
					fields: s.fields
				})),
				selectFields,
				textFieldDefs
			);

			// Persist decrypted results to cold storage (best-effort)
			writeCacheEntry(cacheDb, cacheKey, CACHE_KEY, fresh).catch(() => {});
		} catch (err) {
			if (mode !== 'cached') {
				pageError =
					err instanceof ApiError
						? err.message
						: err instanceof Error
							? err.message
							: 'Failed to load submissions';
				mode = 'error';
			}
		} finally {
			refreshing = false;
		}
	});

	// ── Helpers ────────────────────────────────────────────────────────────────

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleString();
	}

	function toggleType(t: string) {
		if (typeFilter.has(t)) typeFilter.delete(t); else typeFilter.add(t);
	}

	function toggleTextColumn(id: string) {
		if (textColumns.has(id)) textColumns.delete(id); else textColumns.add(id);
	}

	function toggleSelectValue(fieldId: string, value: string) {
		const cur = selectFilters[fieldId] ?? new Set<string>();
		const next = new Set(cur);
		if (next.has(value)) next.delete(value); else next.add(value);
		selectFilters = { ...selectFilters, [fieldId]: next };
	}

	function clearFilters() {
		textQuery = '';
		textColumns.clear();
		typeFilter.clear();
		submittedFrom = '';
		submittedTo = '';
		contentFrom = '';
		contentTo = '';
		hasFilesOnly = false;
		hasArchiveOnly = false;
		selectFilters = {};
	}

	const ALL_TYPES: SubmissionType[] = ['WEBPAGE', 'YOUTUBE_VIDEO', 'INSTAGRAM_POST', 'INSTAGRAM_STORY'];
</script>

<svelte:head><title>Witness – Submissions</title></svelte:head>

<div>
	{#if mode === 'loading'}
		<div class="flex justify-center">
			<span class="loading loading-spinner loading-lg"></span>
		</div>

	{:else if mode === 'error'}
		<div role="alert" class="alert alert-error mx-auto max-w-2xl">
			<span>{pageError}</span>
		</div>

	{:else}
		{#if refreshing}
			<div class="flex items-center gap-2 mb-4 text-sm text-base-content/50">
				<span class="loading loading-spinner loading-xs"></span>
				{m.submissions_refreshing()}
			</div>
		{/if}

		{#if submissions.length > 0}
			<!-- ── Toolbar ─────────────────────────────────────────────────────── -->
			<div class="flex flex-wrap items-center gap-2 mb-2 max-w-2xl">
				<input
					type="search"
					class="input input-bordered flex-1 min-w-48"
					placeholder={m.submissions_search_placeholder()}
					bind:value={textQuery}
					aria-label="Search submissions"
				/>

				<button
					class="btn btn-sm {activeFilterCount > 0 ? 'btn-primary' : 'btn-ghost border border-base-300'}"
					onclick={() => (filtersOpen = !filtersOpen)}
					aria-expanded={filtersOpen}
				>
					Filters
					{#if activeFilterCount > 0}
						<span class="badge badge-sm badge-neutral">{activeFilterCount}</span>
					{/if}
					<span class="text-xs">{filtersOpen ? '▲' : '▼'}</span>
				</button>

				<div class="flex items-center gap-1">
					<select
						class="select select-bordered select-sm"
						bind:value={sortField}
						aria-label="Sort by"
					>
						{#each sortOptions as opt (opt.value)}
							<option value={opt.value}>{opt.label}</option>
						{/each}
					</select>
					<button
						class="btn btn-sm btn-ghost border border-base-300 font-mono"
						onclick={() => (sortDir = sortDir === 'ASC' ? 'DESC' : 'ASC')}
						aria-label="Toggle sort direction"
						title={sortDir === 'ASC' ? 'Ascending' : 'Descending'}
					>
						{sortDir === 'ASC' ? '↑' : '↓'}
					</button>
				</div>
			</div>

			<!-- ── Filter panel ───────────────────────────────────────────────── -->
			{#if filtersOpen}
				<div class="card bg-base-100 shadow mb-4 max-w-2xl">
					<div class="card-body py-4 flex flex-col gap-4">

						<!-- Type toggles -->
						<div>
							<p class="text-sm font-medium mb-2">Type</p>
							<div class="flex flex-wrap gap-2">
								{#each ALL_TYPES as t (t)}
									<button
										class="btn btn-xs {typeFilter.has(t) ? 'btn-primary' : 'btn-ghost border border-base-300'}"
										onclick={() => toggleType(t)}
									>
										{SUBMISSION_TYPE_LABELS[t]}
									</button>
								{/each}
							</div>
						</div>

						<!-- Text column selector (only shown when there are TEXT form fields) -->
						{#if textFormFields.length > 0}
							<div>
								<p class="text-sm font-medium mb-1">Search in</p>
								<div class="flex flex-wrap gap-3">
									{#each textFormFields as f (f.id)}
										<label class="flex items-center gap-1 cursor-pointer text-sm">
											<input
												type="checkbox"
												class="checkbox checkbox-sm"
												checked={textColumns.has(f.id)}
												onchange={() => toggleTextColumn(f.id)}
											/>
											{f.label}
										</label>
									{/each}
								</div>
								<p class="text-xs text-base-content/50 mt-1">
									{textColumns.size === 0 ? 'Searching all columns' : `Searching ${textColumns.size} column${textColumns.size === 1 ? '' : 's'}`}
								</p>
							</div>
						{/if}

						<!-- Submitted date range -->
						<div>
							<p class="text-sm font-medium mb-2">Submitted date</p>
							<div class="flex flex-wrap items-center gap-2">
								<input
									type="date"
									class="input input-bordered input-sm"
									bind:value={submittedFrom}
									aria-label="Submitted from"
								/>
								<span class="text-base-content/50">→</span>
								<input
									type="date"
									class="input input-bordered input-sm"
									bind:value={submittedTo}
									aria-label="Submitted to"
								/>
							</div>
						</div>

						<!-- Content date range (only shown when there are DATE form fields or any submission has a content date) -->
						{#if dateFormFields.length > 0 || hasContentDates}
							<div>
								<p class="text-sm font-medium mb-2">Content date</p>
								<div class="flex flex-wrap items-center gap-2">
									<input
										type="date"
										class="input input-bordered input-sm"
										bind:value={contentFrom}
										aria-label="Content date from"
									/>
									<span class="text-base-content/50">→</span>
									<input
										type="date"
										class="input input-bordered input-sm"
										bind:value={contentTo}
										aria-label="Content date to"
									/>
								</div>
							</div>
						{/if}

						<!-- SELECT field filters -->
						{#each selectFormFields as field (field.id)}
							{@const options = JSON.parse(field.options ?? '[]') as string[]}
							{@const active = selectFilters[field.id] ?? new Set()}
							<div>
								<p class="text-sm font-medium mb-2">{field.label}</p>
								<div class="flex flex-wrap gap-3">
									{#each options as opt (opt)}
										<label class="flex items-center gap-1 cursor-pointer text-sm">
											<input
												type="checkbox"
												class="checkbox checkbox-sm"
												checked={active.has(opt)}
												onchange={() => toggleSelectValue(field.id, opt)}
											/>
											{opt}
										</label>
									{/each}
								</div>
							</div>
						{/each}

						<!-- Boolean filters -->
						<div class="flex flex-wrap gap-4">
							<label class="flex items-center gap-2 cursor-pointer text-sm">
								<input
									type="checkbox"
									class="checkbox checkbox-sm"
									bind:checked={hasFilesOnly}
								/>
								Has files
							</label>
							<label class="flex items-center gap-2 cursor-pointer text-sm">
								<input
									type="checkbox"
									class="checkbox checkbox-sm"
									bind:checked={hasArchiveOnly}
								/>
								Has archive link
							</label>
						</div>

						{#if activeFilterCount > 0}
							<button class="btn btn-sm btn-ghost self-start" onclick={clearFilters}>
								Clear all filters
							</button>
						{/if}
					</div>
				</div>
			{/if}
		{/if}

		<!-- ── Results ─────────────────────────────────────────────────────── -->

		{#if submissions.length === 0}
			<p class="text-base-content/60">{m.submissions_no_submissions()}</p>
		{:else if filteredSortedIds.length === 0}
			<p class="text-base-content/60">{m.submissions_no_match()}</p>
		{:else}
			<div class="flex flex-col gap-4 max-w-2xl">
				{#each visibleSubs as sub (sub.id)}
					<div class="card bg-base-100 shadow" data-testid="submission-card">
						<div class="card-body">
							<div class="flex items-start justify-between mb-2 gap-2 flex-wrap">
								<div class="flex items-center gap-2 flex-wrap">
									<span class="badge badge-primary badge-sm">{SUBMISSION_TYPE_LABELS[sub.type]}</span>
									{#if sub.fileCount > 0}
										<span class="badge badge-ghost badge-sm">{sub.fileCount} file{sub.fileCount !== 1 ? 's' : ''}</span>
									{/if}
									<span class="text-xs font-mono opacity-60">ID: {sub.id}</span>
								</div>
								<div class="text-right">
									<span class="text-xs opacity-60">{formatDate(sub.createdAt)}</span>
									{#if sub.contentDate}
										<div class="text-xs opacity-50">Content: {sub.contentDate}</div>
									{/if}
								</div>
							</div>

							{#if sub.archiveUrl}
								<div class="mb-2">
									<a
										href={sub.archiveUrl}
										target="_blank"
										rel="noopener noreferrer"
										class="link link-primary text-xs"
									>
										{m.submissions_archive_link()}
									</a>
								</div>
							{/if}

							{#if sub.decryptError}
								<div role="alert" class="alert alert-error text-sm">
									<span>{sub.decryptError}</span>
								</div>
							{:else}
								<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
									{#each Object.entries(sub.fields) as [key, value] (key)}
										<dt class="font-medium text-sm opacity-70 capitalize">{key.replace(/^custom_[^_]+_?/, '')}</dt>
										<dd class="text-sm break-all">{value}</dd>
									{/each}
								</dl>
							{/if}
						</div>
					</div>
				{/each}
			</div>

			<!-- ── Pagination ──────────────────────────────────────────────── -->
			{#if totalPages > 1}
				<div class="flex items-center justify-between mt-6 max-w-2xl">
					<button
						class="btn btn-sm btn-ghost"
						onclick={() => (currentPage = Math.max(1, currentPage - 1))}
						disabled={currentPage === 1}
					>
						‹ Prev
					</button>
					<span class="text-sm text-base-content/60">
						Page {currentPage} of {totalPages}
						({filteredSortedIds.length} result{filteredSortedIds.length !== 1 ? 's' : ''})
					</span>
					<button
						class="btn btn-sm btn-ghost"
						onclick={() => (currentPage = Math.min(totalPages, currentPage + 1))}
						disabled={currentPage === totalPages}
					>
						Next ›
					</button>
				</div>
			{/if}
		{/if}
	{/if}
</div>
