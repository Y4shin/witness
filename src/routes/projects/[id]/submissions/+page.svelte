<script lang="ts">
	import { onMount } from 'svelte';
	import {
		decryptSymmetricKey,
		decryptSymmetric,
		importEcdhPrivateKey,
		importUserKeyBundleJwk
	} from '$lib/crypto';
	import type { EncryptedKey } from '$lib/crypto/asymmetric';
	import { loadMembershipForProject } from '$lib/client/key-store';
	import { api, ApiError } from '$lib/client/api';
	import { loadOfflineFileSettings } from '$lib/client/offline-settings';
	import { cacheFileResponse } from '$lib/client/file-cache';
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
	import {
		binPackFiles,
		assignFilenames,
		generateCsv
	} from '$lib/stores/export-utils';
	import type { FileToPack } from '$lib/stores/export-utils';
	import { zipSync } from 'fflate';
	import type { AnyOrama } from '@orama/orama';
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
	let isOffline = $state(false);
	let searchIndex = $state<AnyOrama | null>(null);
	let projectPrivateKey = $state<CryptoKey | null>(null);
	let userEncryptionPrivateKey = $state<CryptoKey | null>(null);

	// ── Export state ───────────────────────────────────────────────────────

	const MAX_ZIP_BYTES = 500 * 1024 * 1024; // 500 MB per ZIP

	type ExportPhase =
		| { kind: 'idle' }
		| { kind: 'planning'; fetched: number; total: number }
		| { kind: 'zipping'; zipIndex: number; zipTotal: number; fileIndex: number; fileTotal: number; filename: string }
		| { kind: 'csv' }
		| { kind: 'done'; zipCount: number }
		| { kind: 'error'; message: string };

	let exportPhase = $state<ExportPhase>({ kind: 'idle' });
	let completedZips = $state<string[]>([]);
	let exportAbortController = $state<AbortController | null>(null);

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
		{ value: 'submittedAt', label: m.submissions_sort_submitted() },
		...(hasContentDates ? [{ value: 'contentDate', label: m.submissions_sort_content_date() }] : []),
		{ value: 'type',      label: m.submissions_sort_type() },
		{ value: 'fileCount', label: m.submissions_sort_files() },
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

	const CACHE_KEY = $derived(`submissions:${data.projectId}`);

	// ── Mount: load + decrypt ─────────────────────────────────────────────────

	onMount(async () => {
		const membership = loadMembershipForProject(data.projectId);
		if (!membership) {
			window.location.href = `/auth?projectId=${data.projectId}&next=/projects/${data.projectId}/submissions`;
			return;
		}

		try {
			const userBundle = await importUserKeyBundleJwk(membership.bundle);
			userEncryptionPrivateKey = userBundle.encryption.privateKey;

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
			if (mode === 'cached') {
				if (!navigator.onLine) isOffline = true;
			} else {
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

	// ── Export helpers ─────────────────────────────────────────────────────

	function triggerDownload(bytes: Uint8Array, filename: string, mimeType: string) {
		const blob = new Blob([bytes], { type: mimeType });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	}

	async function runExport() {
		const ac = new AbortController();
		exportAbortController = ac;
		completedZips = [];

		try {
			// ── Phase 1: Plan ────────────────────────────────────────────────
			// Collect all submissions in the current filtered order that have files
			const orderedSubs = filteredSortedIds
				.map((id, idx) => ({ id, idx, sub: submissions.find((s) => s.id === id) }))
				.filter((x): x is { id: string; idx: number; sub: typeof submissions[number] } => !!x.sub && x.sub.fileCount > 0);

			exportPhase = { kind: 'planning', fetched: 0, total: orderedSubs.length };

			const allFiles: FileToPack[] = [];
			const filesBySubmission = new Map<string, string[]>();
			const fileKeys = new Map<string, string>(); // fileId → encryptedKey (JSON string)

			// Fetch file records in chunks of 10 to avoid too many concurrent requests
			const CHUNK = 10;
			for (let i = 0; i < orderedSubs.length; i += CHUNK) {
				if (ac.signal.aborted) return;

				const chunk = orderedSubs.slice(i, i + CHUNK);
				const results = await Promise.all(
					chunk.map(async ({ id, idx, sub }) => {
						const { files } = await api.files.list(id);
						return { id, idx, sub, files };
					})
				);

				for (const { id, idx, sub, files } of results) {
					filesBySubmission.set(id, files.map((f) => f.id));
					for (const f of files) {
						fileKeys.set(f.id, f.encryptedKey);
						allFiles.push({
							submissionId: id,
							fileId: f.id,
							fieldName: f.fieldName,
							mimeType: f.mimeType,
							sizeBytes: f.sizeBytes,
							submissionIndex: idx,
							submissionType: sub.type
						});
					}
				}

				exportPhase = {
					kind: 'planning',
					fetched: Math.min(i + CHUNK, orderedSubs.length),
					total: orderedSubs.length
				};
			}

			// ── Phase 2: Bin-pack ────────────────────────────────────────────
			const batches = binPackFiles(allFiles, MAX_ZIP_BYTES);
			const dateStr = new Date().toISOString().slice(0, 10);
			const assignments = assignFilenames(batches, filteredSortedIds.length, dateStr);

			// ── Phase 3: Zip loop ────────────────────────────────────────────
			const totalFiles = allFiles.length;
			let filesProcessed = 0;

			for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
				if (ac.signal.aborted) return;

				const batch = batches[batchIdx];
				const zipFiles: Record<string, Uint8Array> = {};

				for (const file of batch) {
					if (ac.signal.aborted) return;

					const packed = assignments.get(file.fileId)!;
					exportPhase = {
						kind: 'zipping',
						zipIndex: batchIdx + 1,
						zipTotal: batches.length,
						fileIndex: filesProcessed + 1,
						fileTotal: totalFiles,
						filename: packed.filename
					};

					// Fetch encrypted bytes and decrypt using the caller's private key:
					// moderators use the project key; submitters use their own user key
					const { bytes: encBytes, url: fileUrl, response: fileResponse } =
						await api.files.downloadEncrypted(file.submissionId, file.fileId);
					// Cache the encrypted response for offline access if the user has enabled it
					const offlineSettings = loadOfflineFileSettings(data.projectId);
					if (
						offlineSettings.enabled &&
						offlineSettings.allowedTypes.includes(file.submissionType)
					) {
						cacheFileResponse(fileUrl, fileResponse, offlineSettings.maxCacheMb).catch(() => {});
					}
					const encKey = JSON.parse(fileKeys.get(file.fileId)!) as EncryptedKey;
					const decryptionKey = data.role === 'MODERATOR' ? projectPrivateKey! : userEncryptionPrivateKey!;
					const symKey = await decryptSymmetricKey(encKey, decryptionKey);
					const iv = encBytes.slice(0, 12);
					const ciphertext = encBytes.slice(12);
					const decrypted = new Uint8Array(
						await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, symKey, ciphertext)
					);

					zipFiles[packed.filename] = decrypted;
					filesProcessed++;
				}

				// Build and immediately download this ZIP
				const zipName = `export-${dateStr}-part${batchIdx + 1}`;
				const zipped = zipSync(zipFiles);
				triggerDownload(zipped, `${zipName}.zip`, 'application/zip');
				completedZips = [...completedZips, zipName];
			}

			// ── Phase 4: CSV ─────────────────────────────────────────────────
			exportPhase = { kind: 'csv' };

			const exportSubs = filteredSortedIds
				.map((id) => submissions.find((s) => s.id === id))
				.filter((s): s is typeof submissions[number] => s !== undefined);

			const csvFields = formFields
				.filter((f) => f.type !== 'FILE')
				.map((f) => ({ id: f.id, label: f.label }));

			const csvStr = generateCsv(
				exportSubs.map((s) => ({
					id: s.id,
					type: s.type,
					createdAt: s.createdAt,
					contentDate: s.contentDate,
					archiveUrl: s.archiveUrl,
					fileCount: s.fileCount,
					fields: s.fields
				})),
				csvFields,
				assignments,
				filesBySubmission
			);

			triggerDownload(
				new TextEncoder().encode(csvStr),
				`export-${dateStr}-submissions.csv`,
				'text/csv;charset=utf-8'
			);

			exportPhase = { kind: 'done', zipCount: batches.length };
		} catch (err) {
			if (!ac.signal.aborted) {
				exportPhase = {
					kind: 'error',
					message: err instanceof Error ? err.message : 'Export failed'
				};
			}
		} finally {
			exportAbortController = null;
		}
	}

	function cancelExport() {
		exportAbortController?.abort();
		exportAbortController = null;
		exportPhase = { kind: 'idle' };
		completedZips = [];
	}
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
		{#if isOffline}
			<div role="status" class="alert alert-warning mb-4 max-w-2xl">{m.submissions_offline_cached()}</div>
		{:else if refreshing}
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
					aria-label={m.submissions_aria_search()}
				/>

				<button
					class="btn btn-sm {activeFilterCount > 0 ? 'btn-primary' : 'btn-ghost border border-base-300'}"
					onclick={() => (filtersOpen = !filtersOpen)}
					aria-expanded={filtersOpen}
				>
					{m.submissions_filters_btn()}
					{#if activeFilterCount > 0}
						<span class="badge badge-sm badge-neutral">{activeFilterCount}</span>
					{/if}
					<span class="text-xs">{filtersOpen ? '▲' : '▼'}</span>
				</button>

				<div class="flex items-center gap-1">
					<select
						class="select select-bordered select-sm"
						bind:value={sortField}
						aria-label={m.submissions_aria_sort_by()}
					>
						{#each sortOptions as opt (opt.value)}
							<option value={opt.value}>{opt.label}</option>
						{/each}
					</select>
					<button
						class="btn btn-sm btn-ghost border border-base-300 font-mono"
						onclick={() => (sortDir = sortDir === 'ASC' ? 'DESC' : 'ASC')}
						aria-label={m.submissions_aria_sort_dir()}
						title={sortDir === 'ASC' ? m.submissions_sort_asc() : m.submissions_sort_desc()}
					>
						{sortDir === 'ASC' ? '↑' : '↓'}
					</button>
				</div>

				<button
					class="btn btn-sm btn-ghost border border-base-300"
					onclick={runExport}
					disabled={exportPhase.kind !== 'idle' || filteredSortedIds.length === 0}
					aria-label={m.submissions_aria_export()}
				>
					{m.submissions_export_btn()}
				</button>
			</div>

			<!-- ── Export progress panel ──────────────────────────────────────── -->
			{#if exportPhase.kind !== 'idle'}
				<div class="card bg-base-100 shadow mb-4 max-w-2xl">
					<div class="card-body py-4 gap-3">

						{#if exportPhase.kind === 'planning'}
							<p class="text-sm font-medium">
								{m.submissions_export_planning()} ({exportPhase.fetched} / {exportPhase.total} {m.submissions_export_submissions_with_files()})…
							</p>
							<progress
								class="progress progress-primary w-full"
								value={exportPhase.fetched}
								max={exportPhase.total || 1}
							></progress>

						{:else if exportPhase.kind === 'zipping'}
							<p class="text-sm font-medium">
								{m.submissions_export_building_zip()} {exportPhase.zipIndex} {m.submissions_export_of()} {exportPhase.zipTotal}
								&nbsp;·&nbsp; {exportPhase.fileIndex} / {exportPhase.fileTotal} {m.submissions_export_files_label()}
							</p>
							<progress
								class="progress progress-primary w-full"
								value={exportPhase.fileIndex}
								max={exportPhase.fileTotal}
							></progress>
							<p class="text-xs text-base-content/50 truncate">
								{m.submissions_export_decrypting()} {exportPhase.filename}
							</p>

						{:else if exportPhase.kind === 'csv'}
							<p class="text-sm font-medium">{m.submissions_export_csv()}</p>

						{:else if exportPhase.kind === 'done'}
							<p class="text-sm font-medium text-success">
								{m.submissions_export_done()} {exportPhase.zipCount > 0 ? exportPhase.zipCount + (exportPhase.zipCount !== 1 ? ' ZIPs + ' : ' ZIP + ') : ''}{m.submissions_export_done_csv()}
							</p>

						{:else if exportPhase.kind === 'error'}
							<p class="text-sm text-error">{m.submissions_export_error()} {exportPhase.message}</p>
						{/if}

						{#if completedZips.length > 0}
							<div class="flex flex-wrap gap-2">
								{#each completedZips as zip (zip)}
									<span class="badge badge-success badge-sm">{zip}.zip ✓</span>
								{/each}
							</div>
						{/if}

						<div class="flex gap-2">
							{#if exportPhase.kind === 'done' || exportPhase.kind === 'error'}
								<button
									class="btn btn-sm btn-ghost"
									onclick={() => { exportPhase = { kind: 'idle' }; completedZips = []; }}
								>
									{m.submissions_export_dismiss()}
								</button>
							{:else}
								<button class="btn btn-sm btn-ghost text-error" onclick={cancelExport}>
									{m.submissions_export_cancel()}
								</button>
							{/if}
						</div>
					</div>
				</div>
			{/if}

			<!-- ── Filter panel ───────────────────────────────────────────────── -->
			{#if filtersOpen}
				<div class="card bg-base-100 shadow mb-4 max-w-2xl">
					<div class="card-body py-4 flex flex-col gap-4">

						<!-- Type toggles -->
						<div>
							<p class="text-sm font-medium mb-2">{m.submissions_filter_type()}</p>
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
								<p class="text-sm font-medium mb-1">{m.submissions_filter_search_in()}</p>
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
									{textColumns.size === 0 ? m.submissions_filter_all_columns() : (textColumns.size === 1 ? m.submissions_filter_columns_singular() : m.submissions_filter_search_in() + ' ' + textColumns.size + ' columns')}
								</p>
							</div>
						{/if}

						<!-- Submitted date range -->
						<div>
							<p class="text-sm font-medium mb-2">{m.submissions_filter_submitted_date()}</p>
							<div class="flex flex-wrap items-center gap-2">
								<input
									type="date"
									class="input input-bordered input-sm"
									bind:value={submittedFrom}
									aria-label={m.submissions_aria_submitted_from()}
								/>
								<span class="text-base-content/50">→</span>
								<input
									type="date"
									class="input input-bordered input-sm"
									bind:value={submittedTo}
									aria-label={m.submissions_aria_submitted_to()}
								/>
							</div>
						</div>

						<!-- Content date range (only shown when there are DATE form fields or any submission has a content date) -->
						{#if dateFormFields.length > 0 || hasContentDates}
							<div>
								<p class="text-sm font-medium mb-2">{m.submissions_filter_content_date()}</p>
								<div class="flex flex-wrap items-center gap-2">
									<input
										type="date"
										class="input input-bordered input-sm"
										bind:value={contentFrom}
										aria-label={m.submissions_aria_content_from()}
									/>
									<span class="text-base-content/50">→</span>
									<input
										type="date"
										class="input input-bordered input-sm"
										bind:value={contentTo}
										aria-label={m.submissions_aria_content_to()}
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
								{m.submissions_filter_has_files()}
							</label>
							<label class="flex items-center gap-2 cursor-pointer text-sm">
								<input
									type="checkbox"
									class="checkbox checkbox-sm"
									bind:checked={hasArchiveOnly}
								/>
								{m.submissions_filter_has_archive()}
							</label>
						</div>

						{#if activeFilterCount > 0}
							<button class="btn btn-sm btn-ghost self-start" onclick={clearFilters}>
								{m.submissions_filter_clear()}
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
										<span class="badge badge-ghost badge-sm">{sub.fileCount} {sub.fileCount !== 1 ? m.submissions_files_badge_plural() : m.submissions_file_badge_singular()}</span>
									{/if}
									<span class="text-xs font-mono opacity-60">ID: {sub.id}</span>
								</div>
								<div class="text-right">
									<span class="text-xs opacity-60">{formatDate(sub.createdAt)}</span>
									{#if sub.contentDate}
										<div class="text-xs opacity-50">{m.submissions_content_label()} {sub.contentDate}</div>
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
							<div class="mt-3 flex justify-end">
								<a href="/projects/{data.projectId}/submissions/{sub.id}" class="btn btn-xs btn-ghost border border-base-300">
									{m.submission_details_view()}
								</a>
							</div>
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
						{m.submissions_prev()}
					</button>
					<span class="text-sm text-base-content/60">
						{m.submissions_page()} {currentPage} {m.submissions_export_of()} {totalPages}
						({filteredSortedIds.length} {filteredSortedIds.length !== 1 ? m.submissions_results_plural() : m.submissions_results_singular()})
					</span>
					<button
						class="btn btn-sm btn-ghost"
						onclick={() => (currentPage = Math.min(totalPages, currentPage + 1))}
						disabled={currentPage === totalPages}
					>
						{m.submissions_next()}
					</button>
				</div>
			{/if}
		{/if}
	{/if}
</div>
