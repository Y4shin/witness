/**
 * Unit tests for the Orama-backed in-memory submission search index.
 *
 * Covers: index building, full-text search, all structured filter types,
 * column-specific text search, contentDate handling, and SELECT field filtering.
 */
import { describe, it, expect } from 'vitest';
import { buildSubmissionIndex, searchSubmissions } from './submissions-search';
import type { IndexableSubmission, SearchParams } from './submissions-search';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_PARAMS: SearchParams = {
	textQuery: '',
	textColumns: new Set(),
	typeFilter: new Set(),
	submittedFrom: '',
	submittedTo: '',
	contentFrom: '',
	contentTo: '',
	hasFilesOnly: false,
	hasArchiveOnly: false,
	selectFilters: {}
};

function sub(overrides: Partial<IndexableSubmission> & { id: string }): IndexableSubmission {
	return {
		userId: 'user-1',
		createdAt: '2026-03-01T10:00:00Z',
		type: 'WEBPAGE',
		archiveUrl: null,
		fileCount: 0,
		contentDate: null,
		fields: {},
		...overrides
	};
}

const SUBS: IndexableSubmission[] = [
	sub({ id: 'a', type: 'WEBPAGE',       fields: { url: 'https://example.com', notes: 'important document' }, contentDate: '2026-01-15', createdAt: '2026-03-01T10:00:00Z' }),
	sub({ id: 'b', type: 'YOUTUBE_VIDEO', fields: { url: 'https://youtube.com/watch?v=xyz', notes: 'video evidence' }, contentDate: '2025-12-01', createdAt: '2026-03-05T12:00:00Z', fileCount: 2 }),
	sub({ id: 'c', type: 'INSTAGRAM_POST',fields: { url: 'https://instagram.com/p/abc', notes: 'photo post' }, archiveUrl: 'https://archive.ph/xyz', createdAt: '2026-02-10T08:00:00Z' }),
	sub({ id: 'd', type: 'WEBPAGE',       fields: { url: 'https://news.example.org' }, contentDate: '2026-03-10', createdAt: '2026-03-10T16:00:00Z' })
];

async function makeDb(subs = SUBS) {
	return buildSubmissionIndex(subs, []);
}

// ── Index building ─────────────────────────────────────────────────────────────

describe('buildSubmissionIndex', () => {
	it('returns all ids when no filters are applied', async () => {
		const db = await makeDb();
		const ids = await searchSubmissions(db, BASE_PARAMS);
		expect(new Set(ids)).toEqual(new Set(['a', 'b', 'c', 'd']));
	});

	it('contentDate is stored as 0 when null', async () => {
		const db = await buildSubmissionIndex(
			[sub({ id: 'x', contentDate: null })],
			[]
		);
		// filter contentDate gte 1 — 'x' has 0 so should be excluded
		const ids = await searchSubmissions(db, {
			...BASE_PARAMS,
			contentFrom: '2020-01-01'
		});
		expect(ids).not.toContain('x');
	});
});

// ── Full-text search ───────────────────────────────────────────────────────────

describe('text search', () => {
	it('finds submissions containing the query term', async () => {
		const db = await makeDb();
		const ids = await searchSubmissions(db, { ...BASE_PARAMS, textQuery: 'important' });
		expect(ids).toContain('a');
		expect(ids).not.toContain('b');
	});

	it('is case-insensitive', async () => {
		const db = await makeDb();
		const ids = await searchSubmissions(db, { ...BASE_PARAMS, textQuery: 'VIDEO' });
		expect(ids).toContain('b');
	});

	it('returns empty when no match', async () => {
		const db = await makeDb();
		const ids = await searchSubmissions(db, { ...BASE_PARAMS, textQuery: 'zzznomatch' });
		expect(ids).toHaveLength(0);
	});
});

// ── Column-specific text search ────────────────────────────────────────────────

describe('textColumns (column-specific search)', () => {
	const TEXT_FIELDS = [
		{ id: 'url-field', label: 'URL' },
		{ id: 'notes-field', label: 'Notes' }
	];

	const COL_SUBS: IndexableSubmission[] = [
		sub({ id: 'p', fields: { 'custom_url-field': 'https://example.com', 'custom_notes-field': 'special note' } }),
		sub({ id: 'q', fields: { 'custom_url-field': 'https://other.org',   'custom_notes-field': 'nothing here' } })
	];

	it('searching a specific column only matches that column', async () => {
		const db = await buildSubmissionIndex(COL_SUBS, [], TEXT_FIELDS);
		// 'special' only appears in notes of 'p'
		const ids = await searchSubmissions(db, {
			...BASE_PARAMS,
			textQuery: 'special',
			textColumns: new Set(['notes-field'])
		});
		expect(ids).toContain('p');
		expect(ids).not.toContain('q');
	});

	it('empty textColumns falls back to searching all text via _text', async () => {
		const db = await buildSubmissionIndex(COL_SUBS, [], TEXT_FIELDS);
		const ids = await searchSubmissions(db, {
			...BASE_PARAMS,
			textQuery: 'special',
			textColumns: new Set()
		});
		expect(ids).toContain('p');
	});

	it('column search does not match text in a different column', async () => {
		const db = await buildSubmissionIndex(COL_SUBS, [], TEXT_FIELDS);
		// 'example' is in url-field of 'p', searching only notes-field should not find it
		const ids = await searchSubmissions(db, {
			...BASE_PARAMS,
			textQuery: 'example',
			textColumns: new Set(['notes-field'])
		});
		expect(ids).not.toContain('p');
	});
});

// ── Type filter ───────────────────────────────────────────────────────────────

describe('type filter', () => {
	it('filters by a single type', async () => {
		const db = await makeDb();
		const ids = await searchSubmissions(db, {
			...BASE_PARAMS,
			typeFilter: new Set(['YOUTUBE_VIDEO'])
		});
		expect(ids).toEqual(['b']);
	});

	it('filters by multiple types', async () => {
		const db = await makeDb();
		const ids = await searchSubmissions(db, {
			...BASE_PARAMS,
			typeFilter: new Set(['WEBPAGE', 'INSTAGRAM_POST'])
		});
		expect(new Set(ids)).toEqual(new Set(['a', 'c', 'd']));
	});

	it('empty type filter returns all', async () => {
		const db = await makeDb();
		const ids = await searchSubmissions(db, { ...BASE_PARAMS, typeFilter: new Set() });
		expect(ids).toHaveLength(4);
	});
});

// ── Submitted date range ───────────────────────────────────────────────────────

describe('submitted date range', () => {
	it('filters by from date', async () => {
		const db = await makeDb();
		const ids = await searchSubmissions(db, { ...BASE_PARAMS, submittedFrom: '2026-03-04' });
		// only b (2026-03-05) and d (2026-03-10) are >= 2026-03-04
		expect(new Set(ids)).toEqual(new Set(['b', 'd']));
	});

	it('filters by to date', async () => {
		const db = await makeDb();
		const ids = await searchSubmissions(db, { ...BASE_PARAMS, submittedTo: '2026-02-28' });
		// only c (2026-02-10) is <= 2026-02-28
		expect(ids).toContain('c');
		expect(ids).not.toContain('a');
	});

	it('filters by combined from/to range', async () => {
		const db = await makeDb();
		const ids = await searchSubmissions(db, {
			...BASE_PARAMS,
			submittedFrom: '2026-03-01',
			submittedTo: '2026-03-06'
		});
		// a (2026-03-01) and b (2026-03-05) are in range
		expect(new Set(ids)).toEqual(new Set(['a', 'b']));
	});
});

// ── Content date range ─────────────────────────────────────────────────────────

describe('content date range', () => {
	it('filters by content from date', async () => {
		const db = await makeDb();
		// a has contentDate 2026-01-15, b has 2025-12-01, c and d have null/2026-03-10
		const ids = await searchSubmissions(db, { ...BASE_PARAMS, contentFrom: '2026-01-01' });
		expect(ids).toContain('a');
		expect(ids).not.toContain('b'); // 2025-12-01 is before
	});

	it('filters by content to date', async () => {
		const db = await makeDb();
		const ids = await searchSubmissions(db, { ...BASE_PARAMS, contentTo: '2025-12-31' });
		expect(ids).toContain('b'); // 2025-12-01
		expect(ids).not.toContain('a'); // 2026-01-15
	});

	it('submissions with null contentDate (stored as 0) are excluded from range filter', async () => {
		const db = await makeDb();
		const ids = await searchSubmissions(db, { ...BASE_PARAMS, contentFrom: '2026-01-01' });
		// c has null contentDate (0 ms), d has 2026-03-10
		expect(ids).not.toContain('c');
		expect(ids).toContain('d');
	});
});

// ── Boolean filters ────────────────────────────────────────────────────────────

describe('boolean filters', () => {
	it('hasFilesOnly returns only submissions with files', async () => {
		const db = await makeDb();
		const ids = await searchSubmissions(db, { ...BASE_PARAMS, hasFilesOnly: true });
		expect(ids).toEqual(['b']); // only b has fileCount 2
	});

	it('hasArchiveOnly returns only submissions with an archive URL', async () => {
		const db = await makeDb();
		const ids = await searchSubmissions(db, { ...BASE_PARAMS, hasArchiveOnly: true });
		expect(ids).toEqual(['c']);
	});
});

// ── SELECT field filter ────────────────────────────────────────────────────────

describe('SELECT field filter', () => {
	const SELECT_FIELD = { id: 'field-cat', type: 'SELECT' as const, options: '["news","legal","social"]' };

	const SELECT_SUBS: IndexableSubmission[] = [
		sub({ id: 's1', fields: { 'custom_field-cat': 'news' } }),
		sub({ id: 's2', fields: { 'custom_field-cat': 'legal' } }),
		sub({ id: 's3', fields: { 'custom_field-cat': 'social' } }),
		sub({ id: 's4', fields: {} })
	];

	it('filters by a single select value', async () => {
		const db = await buildSubmissionIndex(SELECT_SUBS, [SELECT_FIELD]);
		const ids = await searchSubmissions(db, {
			...BASE_PARAMS,
			selectFilters: { 'field-cat': new Set(['news']) }
		});
		expect(ids).toEqual(['s1']);
	});

	it('filters by multiple select values (OR)', async () => {
		const db = await buildSubmissionIndex(SELECT_SUBS, [SELECT_FIELD]);
		const ids = await searchSubmissions(db, {
			...BASE_PARAMS,
			selectFilters: { 'field-cat': new Set(['news', 'legal']) }
		});
		expect(new Set(ids)).toEqual(new Set(['s1', 's2']));
	});

	it('empty select filter set returns all', async () => {
		const db = await buildSubmissionIndex(SELECT_SUBS, [SELECT_FIELD]);
		const ids = await searchSubmissions(db, {
			...BASE_PARAMS,
			selectFilters: { 'field-cat': new Set() }
		});
		expect(ids).toHaveLength(4);
	});
});

// ── Combined filters ───────────────────────────────────────────────────────────

describe('combined filters', () => {
	it('type + text search returns intersection', async () => {
		const db = await makeDb();
		const ids = await searchSubmissions(db, {
			...BASE_PARAMS,
			typeFilter: new Set(['WEBPAGE']),
			textQuery: 'important'
		});
		expect(ids).toContain('a');
		expect(ids).not.toContain('b');
		expect(ids).not.toContain('d'); // WEBPAGE but no 'important' text
	});

	it('date range + hasFiles returns intersection', async () => {
		const db = await makeDb();
		const ids = await searchSubmissions(db, {
			...BASE_PARAMS,
			submittedFrom: '2026-03-01',
			hasFilesOnly: true
		});
		expect(ids).toEqual(['b']); // only b has files and was submitted >= 2026-03-01
	});
});
