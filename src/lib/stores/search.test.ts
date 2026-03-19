/**
 * Unit tests for submission in-memory search filter logic (Step 17).
 * Tests the filter function in isolation — no DOM needed.
 */
import { describe, it, expect } from 'vitest';
import { SUBMISSION_TYPE_LABELS } from '$lib/submission-types';
import type { SubmissionType } from '$lib/api-types';

// ── mirror of the filter logic used in the submissions page ─────────────────

type DecryptedSubmission = {
	id: string;
	type: SubmissionType;
	fields: Record<string, string>;
};

function filterSubmissions(submissions: DecryptedSubmission[], query: string): DecryptedSubmission[] {
	const q = query.trim().toLowerCase();
	if (!q) return submissions;
	return submissions.filter((s) => {
		if (s.id.toLowerCase().includes(q)) return true;
		if (SUBMISSION_TYPE_LABELS[s.type].toLowerCase().includes(q)) return true;
		return Object.values(s.fields).some((v) => v.toLowerCase().includes(q));
	});
}

const SAMPLES: DecryptedSubmission[] = [
	{ id: 'aaa-111', type: 'WEBPAGE', fields: { url: 'https://example.com/cats', notes: 'a cat page' } },
	{ id: 'bbb-222', type: 'YOUTUBE_VIDEO', fields: { url: 'https://youtube.com/watch?v=dogs', notes: '' } },
	{ id: 'ccc-333', type: 'INSTAGRAM_POST', fields: { url: 'https://instagram.com/p/xyz', notes: 'misinformation' } },
	{ id: 'ddd-444', type: 'INSTAGRAM_STORY', fields: { username: '@suspicious_user', notes: '' } }
];

// ── tests ────────────────────────────────────────────────────────────────────

describe('submission search filter', () => {
	it('empty query returns all submissions', () => {
		expect(filterSubmissions(SAMPLES, '')).toHaveLength(4);
		expect(filterSubmissions(SAMPLES, '   ')).toHaveLength(4);
	});

	it('matches by field value (case-insensitive)', () => {
		const results = filterSubmissions(SAMPLES, 'cats');
		expect(results).toHaveLength(1);
		expect(results[0].id).toBe('aaa-111');
	});

	it('matches by submission type label', () => {
		const results = filterSubmissions(SAMPLES, 'youtube');
		expect(results).toHaveLength(1);
		expect(results[0].type).toBe('YOUTUBE_VIDEO');
	});

	it('matches by submission ID prefix', () => {
		const results = filterSubmissions(SAMPLES, 'ccc');
		expect(results).toHaveLength(1);
		expect(results[0].id).toBe('ccc-333');
	});

	it('returns empty array when nothing matches', () => {
		expect(filterSubmissions(SAMPLES, 'zzz-no-match')).toHaveLength(0);
	});

	it('is case-insensitive', () => {
		expect(filterSubmissions(SAMPLES, 'CATS')).toHaveLength(1);
		expect(filterSubmissions(SAMPLES, 'Instagram')).toHaveLength(2);
	});

	it('special regex characters do not throw', () => {
		expect(() => filterSubmissions(SAMPLES, '.*[')).not.toThrow();
		expect(filterSubmissions(SAMPLES, '.*[')).toHaveLength(0);
	});

	it('matches across multiple fields in the same submission', () => {
		const results = filterSubmissions(SAMPLES, 'misinformation');
		expect(results).toHaveLength(1);
		expect(results[0].id).toBe('ccc-333');
	});
});
