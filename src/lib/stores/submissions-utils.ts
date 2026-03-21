/**
 * Pure utility functions for sorting, pagination, and field extraction
 * on decrypted submission data. Framework-free so they can be unit tested.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface SortableSubmission {
	id: string;
	createdAt: string;        // ISO-8601
	type: string;
	fileCount: number;
	contentDate: string | null; // ISO date or null
	fields: Record<string, string>;
}

export type SortDirection = 'ASC' | 'DESC';

// ── Sorting ────────────────────────────────────────────────────────────────

/**
 * Returns a new sorted copy of `ids` according to `sortField` and `sortDir`.
 * `sortField` is one of the fixed fields or a custom field key (e.g. `custom_abc`).
 * IDs not present in `subMap` are placed last.
 */
export function sortSubmissionIds(
	ids: string[],
	subMap: Map<string, SortableSubmission>,
	sortField: string,
	sortDir: SortDirection
): string[] {
	return ids.slice().sort((a, b) => {
		const sa = subMap.get(a);
		const sb = subMap.get(b);
		if (!sa && !sb) return 0;
		if (!sa) return 1;
		if (!sb) return -1;

		let cmp = 0;
		if (sortField === 'submittedAt') {
			cmp = new Date(sa.createdAt).getTime() - new Date(sb.createdAt).getTime();
		} else if (sortField === 'contentDate') {
			const da = sa.contentDate ? new Date(sa.contentDate).getTime() : 0;
			const db = sb.contentDate ? new Date(sb.contentDate).getTime() : 0;
			cmp = da - db;
		} else if (sortField === 'type') {
			cmp = sa.type.localeCompare(sb.type);
		} else if (sortField === 'fileCount') {
			cmp = sa.fileCount - sb.fileCount;
		} else {
			// Custom TEXT field key (e.g. `custom_abc`)
			const va = sa.fields[sortField] ?? '';
			const vb = sb.fields[sortField] ?? '';
			cmp = va.localeCompare(vb);
		}

		return sortDir === 'ASC' ? cmp : -cmp;
	});
}

// ── Pagination ─────────────────────────────────────────────────────────────

/**
 * Returns the slice of `ids` for `page` (1-based) given `pageSize`.
 */
export function paginateIds(ids: string[], page: number, pageSize: number): string[] {
	const start = (page - 1) * pageSize;
	return ids.slice(start, start + pageSize);
}

/**
 * Returns the total page count (at least 1).
 */
export function totalPages(count: number, pageSize: number): number {
	return Math.max(1, Math.ceil(count / pageSize));
}

// ── Content date extraction ────────────────────────────────────────────────

/**
 * Finds the first non-empty value stored under `custom_${fieldId}` for any
 * DATE-type field ID in `dateFieldIds`, returning it as the content date.
 * Returns null when no DATE field has a value.
 */
export function extractContentDate(
	fields: Record<string, string>,
	dateFieldIds: Iterable<string>
): string | null {
	for (const fieldId of dateFieldIds) {
		const val = fields[`custom_${fieldId}`];
		if (val) return val;
	}
	return null;
}
