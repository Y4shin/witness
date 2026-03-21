/**
 * Unit tests for submissions-utils: sortSubmissionIds, paginateIds,
 * totalPages, and extractContentDate.
 */
import { describe, it, expect } from 'vitest';
import {
	sortSubmissionIds,
	paginateIds,
	totalPages,
	extractContentDate
} from './submissions-utils';
import type { SortableSubmission } from './submissions-utils';

// ── Fixtures ──────────────────────────────────────────────────────────────

function sub(overrides: Partial<SortableSubmission> & { id: string }): SortableSubmission {
	return {
		createdAt: '2026-01-01T00:00:00Z',
		type: 'WEBPAGE',
		fileCount: 0,
		contentDate: null,
		fields: {},
		...overrides
	};
}

const SUBS: SortableSubmission[] = [
	sub({ id: 'a', createdAt: '2026-01-01T00:00:00Z', type: 'WEBPAGE',        fileCount: 0, contentDate: '2025-06-01', fields: { custom_tag: 'beta' } }),
	sub({ id: 'b', createdAt: '2026-03-15T00:00:00Z', type: 'YOUTUBE_VIDEO',  fileCount: 3, contentDate: '2026-02-01', fields: { custom_tag: 'alpha' } }),
	sub({ id: 'c', createdAt: '2026-02-10T00:00:00Z', type: 'INSTAGRAM_POST', fileCount: 1, contentDate: null,         fields: { custom_tag: 'gamma' } }),
];

const IDS = ['a', 'b', 'c'];
const MAP = new Map(SUBS.map((s) => [s.id, s]));

// ── sortSubmissionIds ─────────────────────────────────────────────────────

describe('sortSubmissionIds — submittedAt', () => {
	it('ASC orders oldest first', () => {
		expect(sortSubmissionIds(IDS, MAP, 'submittedAt', 'ASC')).toEqual(['a', 'c', 'b']);
	});

	it('DESC orders newest first', () => {
		expect(sortSubmissionIds(IDS, MAP, 'submittedAt', 'DESC')).toEqual(['b', 'c', 'a']);
	});
});

describe('sortSubmissionIds — contentDate', () => {
	it('ASC: null (stored as 0) sorts before real dates', () => {
		const result = sortSubmissionIds(IDS, MAP, 'contentDate', 'ASC');
		expect(result.indexOf('c')).toBeLessThan(result.indexOf('a'));
		expect(result.indexOf('a')).toBeLessThan(result.indexOf('b'));
	});

	it('DESC: most recent content date first', () => {
		const result = sortSubmissionIds(IDS, MAP, 'contentDate', 'DESC');
		expect(result[0]).toBe('b'); // 2026-02-01
	});
});

describe('sortSubmissionIds — type', () => {
	it('ASC sorts alphabetically', () => {
		const result = sortSubmissionIds(IDS, MAP, 'type', 'ASC');
		expect(result).toEqual(['c', 'a', 'b']); // INSTAGRAM_POST < WEBPAGE < YOUTUBE_VIDEO
	});

	it('DESC reverses alphabetical order', () => {
		const result = sortSubmissionIds(IDS, MAP, 'type', 'DESC');
		expect(result).toEqual(['b', 'a', 'c']);
	});
});

describe('sortSubmissionIds — fileCount', () => {
	it('ASC: fewest files first', () => {
		expect(sortSubmissionIds(IDS, MAP, 'fileCount', 'ASC')).toEqual(['a', 'c', 'b']);
	});

	it('DESC: most files first', () => {
		expect(sortSubmissionIds(IDS, MAP, 'fileCount', 'DESC')).toEqual(['b', 'c', 'a']);
	});
});

describe('sortSubmissionIds — custom field', () => {
	it('ASC: sorts by field value lexicographically', () => {
		const result = sortSubmissionIds(IDS, MAP, 'custom_tag', 'ASC');
		expect(result).toEqual(['b', 'a', 'c']); // alpha < beta < gamma
	});

	it('DESC: reverse lexicographic', () => {
		const result = sortSubmissionIds(IDS, MAP, 'custom_tag', 'DESC');
		expect(result).toEqual(['c', 'a', 'b']);
	});

	it('missing field value treated as empty string (sorts first in ASC)', () => {
		const noTag = [
			...SUBS,
			sub({ id: 'd', fields: {} }) // no custom_tag
		];
		const map = new Map(noTag.map((s) => [s.id, s]));
		const result = sortSubmissionIds([...IDS, 'd'], map, 'custom_tag', 'ASC');
		expect(result[0]).toBe('d');
	});
});

describe('sortSubmissionIds — unknown IDs', () => {
	it('IDs not in map are placed last', () => {
		const result = sortSubmissionIds(['a', 'unknown', 'b'], MAP, 'submittedAt', 'ASC');
		expect(result[result.length - 1]).toBe('unknown');
	});
});

describe('sortSubmissionIds — does not mutate input', () => {
	it('returns a new array', () => {
		const input = [...IDS];
		const result = sortSubmissionIds(input, MAP, 'submittedAt', 'ASC');
		expect(result).not.toBe(input);
		expect(input).toEqual(IDS); // original unchanged
	});
});

// ── paginateIds ───────────────────────────────────────────────────────────

describe('paginateIds', () => {
	const ALL = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

	it('returns first page', () => {
		expect(paginateIds(ALL, 1, 3)).toEqual(['a', 'b', 'c']);
	});

	it('returns middle page', () => {
		expect(paginateIds(ALL, 2, 3)).toEqual(['d', 'e', 'f']);
	});

	it('returns partial last page', () => {
		expect(paginateIds(ALL, 3, 3)).toEqual(['g']);
	});

	it('page beyond end returns empty array', () => {
		expect(paginateIds(ALL, 4, 3)).toEqual([]);
	});

	it('pageSize larger than list returns everything', () => {
		expect(paginateIds(ALL, 1, 100)).toEqual(ALL);
	});

	it('empty input returns empty', () => {
		expect(paginateIds([], 1, 10)).toEqual([]);
	});
});

// ── totalPages ────────────────────────────────────────────────────────────

describe('totalPages', () => {
	it('exact multiple', () => {
		expect(totalPages(10, 5)).toBe(2);
	});

	it('rounds up', () => {
		expect(totalPages(11, 5)).toBe(3);
	});

	it('returns 1 for empty list', () => {
		expect(totalPages(0, 25)).toBe(1);
	});

	it('returns 1 when count equals pageSize', () => {
		expect(totalPages(25, 25)).toBe(1);
	});
});

// ── extractContentDate ────────────────────────────────────────────────────

describe('extractContentDate', () => {
	it('returns value of the matching DATE field', () => {
		const fields = { custom_date1: '2026-03-15' };
		expect(extractContentDate(fields, ['date1'])).toBe('2026-03-15');
	});

	it('returns null when no DATE field matches', () => {
		expect(extractContentDate({}, ['date1'])).toBeNull();
	});

	it('returns null when field is empty string', () => {
		const fields = { custom_date1: '' };
		expect(extractContentDate(fields, ['date1'])).toBeNull();
	});

	it('returns first non-empty field when multiple DATE fields exist', () => {
		const fields = { custom_d1: '', custom_d2: '2026-05-01' };
		expect(extractContentDate(fields, ['d1', 'd2'])).toBe('2026-05-01');
	});

	it('stops at the first non-empty field', () => {
		const fields = { custom_d1: '2026-01-01', custom_d2: '2026-06-01' };
		expect(extractContentDate(fields, ['d1', 'd2'])).toBe('2026-01-01');
	});

	it('works with a Set of field IDs', () => {
		const fields = { custom_x: '2026-09-09' };
		expect(extractContentDate(fields, new Set(['x']))).toBe('2026-09-09');
	});
});
