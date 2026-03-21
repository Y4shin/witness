/**
 * Orama-backed in-memory search index for decrypted submissions.
 *
 * Lives entirely in the JS heap — never written to any persistent storage.
 * Callers must null the returned instance when navigating away (onDestroy).
 */
import { create, insertMultiple, search } from '@orama/orama';
import type { AnyOrama } from '@orama/orama';
import type { FieldType } from '$lib/api-types';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IndexableSubmission {
	id: string;
	userId: string;
	createdAt: string;        // ISO-8601 — maps to submittedAt (number)
	type: string;
	archiveUrl: string | null;
	fileCount: number;
	contentDate: string | null; // ISO-8601 date or null — extracted from DATE-type form field
	fields: Record<string, string>;
}

export interface SelectField {
	id: string;
	type: FieldType;
	options: string | null; // JSON-encoded string[]
}

export interface TextSearchField {
	id: string;   // form field id — stored as text_${id} in the Orama schema
	label: string;
}

export interface SearchParams {
	textQuery: string;
	textColumns: Set<string>; // field IDs to search in; empty = search _text (all columns)
	typeFilter: Set<string>;
	submittedFrom: string;   // 'YYYY-MM-DD' or ''
	submittedTo: string;
	contentFrom: string;
	contentTo: string;
	hasFilesOnly: boolean;
	hasArchiveOnly: boolean;
	selectFilters: Record<string, Set<string>>; // fieldId → selected values
}

// ── Index building ─────────────────────────────────────────────────────────────

/**
 * Creates a fresh Orama instance and bulk-inserts all submissions.
 * The schema is built dynamically:
 *  - Fixed properties for structured filtering
 *  - One `select_${id}` enum property per SELECT custom field
 *  - One `text_${id}` string property per TEXT custom field (for column-specific search)
 *  - `_text` concatenation of all text values for "search all" mode
 */
export async function buildSubmissionIndex(
	subs: IndexableSubmission[],
	selectFields: SelectField[],
	textFields: TextSearchField[] = []
): Promise<AnyOrama> {
	const schema: Record<string, string> = {
		id: 'string',
		userId: 'string',
		type: 'enum',
		submittedAt: 'number',
		contentDate: 'number',
		hasFiles: 'boolean',
		hasArchive: 'boolean',
		_text: 'string'
	};

	for (const f of selectFields) {
		schema[`select_${f.id}`] = 'enum';
	}
	for (const f of textFields) {
		schema[`text_${f.id}`] = 'string';
	}

	const db = await create({ schema });

	const docs = subs.map((s) => {
		// Concatenate all text field values for "search all" mode.
		// contentDate is excluded — it's a date, not searchable text.
		const textParts = Object.values(s.fields).filter(Boolean);

		const doc: Record<string, unknown> = {
			id: s.id,
			userId: s.userId,
			type: s.type,
			submittedAt: new Date(s.createdAt).getTime(),
			contentDate: s.contentDate ? new Date(s.contentDate).getTime() : 0,
			hasFiles: s.fileCount > 0,
			hasArchive: s.archiveUrl != null,
			_text: textParts.join(' ')
		};

		for (const f of selectFields) {
			doc[`select_${f.id}`] = s.fields[`custom_${f.id}`] ?? '';
		}
		for (const f of textFields) {
			doc[`text_${f.id}`] = s.fields[`custom_${f.id}`] ?? s.fields[f.id] ?? '';
		}

		return doc;
	});

	await insertMultiple(db, docs as any);
	return db;
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Runs a search against an existing Orama index with all active filters and
 * returns the matching submission IDs in Orama's internal order.
 * Sorting is handled by the caller.
 */
export async function searchSubmissions(
	db: AnyOrama,
	params: SearchParams
): Promise<string[]> {
	const {
		textQuery: tq,
		textColumns: tc,
		typeFilter: tf,
		submittedFrom: sf,
		submittedTo: st,
		contentFrom: cf,
		contentTo: ct,
		hasFilesOnly: hf,
		hasArchiveOnly: ha,
		selectFilters: selF
	} = params;

	const where: Record<string, unknown> = {};

	if (tf.size > 0) where['type'] = { in: [...tf] };
	if (hf) where['hasFiles'] = { eq: true };
	if (ha) where['hasArchive'] = { eq: true };

	if (sf && st) {
		where['submittedAt'] = { between: [new Date(sf).getTime(), new Date(st + 'T23:59:59').getTime()] };
	} else if (sf) {
		where['submittedAt'] = { gte: new Date(sf).getTime() };
	} else if (st) {
		where['submittedAt'] = { lte: new Date(st + 'T23:59:59').getTime() };
	}

	if (cf && ct) {
		where['contentDate'] = { between: [new Date(cf).getTime(), new Date(ct + 'T23:59:59').getTime()] };
	} else if (cf) {
		where['contentDate'] = { gte: new Date(cf).getTime() };
	} else if (ct) {
		where['contentDate'] = { lte: new Date(ct + 'T23:59:59').getTime() };
	}

	for (const [fieldId, values] of Object.entries(selF)) {
		if (values.size > 0) where[`select_${fieldId}`] = { in: [...values] };
	}

	// Determine which properties to search for full-text
	let properties: string[] | '*';
	if (tq) {
		properties = tc.size > 0
			? [...tc].map((id) => `text_${id}`)
			: ['_text'];
	} else {
		properties = '*';
	}

	const results = await search(db, {
		term: tq || '',
		properties,
		where: Object.keys(where).length > 0 ? where : undefined,
		limit: 10_000
	} as any);

	return results.hits.map((h: any) => h.document.id as string);
}
