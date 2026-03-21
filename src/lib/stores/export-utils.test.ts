/**
 * Unit tests for export-utils: mimeToExt, descriptiveFilename,
 * binPackFiles, assignFilenames, and generateCsv.
 */
import { describe, it, expect } from 'vitest';
import {
	mimeToExt,
	descriptiveFilename,
	binPackFiles,
	assignFilenames,
	generateCsv
} from './export-utils';
import type { FileToPack, CsvSubmission, CsvFormField } from './export-utils';

// ── mimeToExt ─────────────────────────────────────────────────────────────

describe('mimeToExt', () => {
	it('maps known MIME types', () => {
		expect(mimeToExt('image/jpeg')).toBe('.jpg');
		expect(mimeToExt('image/png')).toBe('.png');
		expect(mimeToExt('video/mp4')).toBe('.mp4');
		expect(mimeToExt('application/pdf')).toBe('.pdf');
		expect(mimeToExt('audio/mpeg')).toBe('.mp3');
	});

	it('returns empty string for unknown type', () => {
		expect(mimeToExt('application/x-unknown')).toBe('');
	});

	it('returns empty string for null', () => {
		expect(mimeToExt(null)).toBe('');
	});
});

// ── descriptiveFilename ───────────────────────────────────────────────────

describe('descriptiveFilename', () => {
	it('pads index to the width of totalSubmissions', () => {
		expect(descriptiveFilename(0, 100, 'WEBPAGE', 'evidence', 'image/jpeg', 1))
			.toBe('001-webpage-evidence.jpg');
		expect(descriptiveFilename(0, 10, 'WEBPAGE', 'evidence', 'image/jpeg', 1))
			.toBe('01-webpage-evidence.jpg');
		expect(descriptiveFilename(0, 1, 'WEBPAGE', 'evidence', 'image/jpeg', 1))
			.toBe('1-webpage-evidence.jpg');
	});

	it('slugifies submission type (underscores → hyphens, lowercase)', () => {
		expect(descriptiveFilename(0, 10, 'YOUTUBE_VIDEO', 'evidence', 'video/mp4', 1))
			.toBe('01-youtube-video-evidence.mp4');
		expect(descriptiveFilename(0, 10, 'INSTAGRAM_POST', 'screenshot', 'image/png', 1))
			.toBe('01-instagram-post-screenshot.png');
	});

	it('slugifies field name (special chars → hyphens, trimmed)', () => {
		expect(descriptiveFilename(0, 10, 'WEBPAGE', 'My Evidence File!', 'image/jpeg', 1))
			.toBe('01-webpage-my-evidence-file.jpg');
	});

	it('omits disambiguator suffix when it is 1', () => {
		const name = descriptiveFilename(2, 10, 'WEBPAGE', 'evidence', 'image/png', 1);
		expect(name).not.toContain('-1.');
		expect(name).toBe('03-webpage-evidence.png');
	});

	it('appends disambiguator suffix when > 1', () => {
		expect(descriptiveFilename(2, 10, 'WEBPAGE', 'evidence', 'image/png', 2))
			.toBe('03-webpage-evidence-2.png');
		expect(descriptiveFilename(2, 10, 'WEBPAGE', 'evidence', 'image/png', 3))
			.toBe('03-webpage-evidence-3.png');
	});

	it('uses empty extension when mimeType is null', () => {
		expect(descriptiveFilename(0, 10, 'WEBPAGE', 'doc', null, 1))
			.toBe('01-webpage-doc');
	});

	it('uses submission index + 1 as the human-readable number', () => {
		expect(descriptiveFilename(41, 100, 'WEBPAGE', 'evidence', null, 1))
			.toMatch(/^042-/);
	});
});

// ── binPackFiles ──────────────────────────────────────────────────────────

function makeFile(id: string, sizeBytes: number, extra?: Partial<FileToPack>): FileToPack {
	return {
		submissionId: 'sub-1',
		fileId: id,
		fieldName: 'evidence',
		mimeType: 'image/jpeg',
		sizeBytes,
		submissionIndex: 0,
		submissionType: 'WEBPAGE',
		...extra
	};
}

describe('binPackFiles', () => {
	it('returns empty array for empty input', () => {
		expect(binPackFiles([], 100)).toEqual([]);
	});

	it('single file that fits goes into one batch', () => {
		const result = binPackFiles([makeFile('a', 50)], 100);
		expect(result).toHaveLength(1);
		expect(result[0]).toHaveLength(1);
	});

	it('multiple files that fit together go into one batch', () => {
		const result = binPackFiles([makeFile('a', 30), makeFile('b', 30), makeFile('c', 30)], 100);
		expect(result).toHaveLength(1);
		expect(result[0]).toHaveLength(3);
	});

	it('splits into new batch when limit would be exceeded', () => {
		const result = binPackFiles([makeFile('a', 60), makeFile('b', 60)], 100);
		expect(result).toHaveLength(2);
		expect(result[0][0].fileId).toBe('a');
		expect(result[1][0].fileId).toBe('b');
	});

	it('a single file larger than maxBytes gets its own batch', () => {
		const result = binPackFiles([makeFile('huge', 200)], 100);
		expect(result).toHaveLength(1);
		expect(result[0][0].fileId).toBe('huge');
	});

	it('oversized file after normal files starts a new batch', () => {
		const result = binPackFiles([makeFile('a', 40), makeFile('huge', 200)], 100);
		expect(result).toHaveLength(2);
		expect(result[0][0].fileId).toBe('a');
		expect(result[1][0].fileId).toBe('huge');
	});

	it('fills batches greedily', () => {
		// 3 files of 40 bytes each, maxBytes=100 → [a,b] [c]
		const result = binPackFiles(
			[makeFile('a', 40), makeFile('b', 40), makeFile('c', 40)],
			100
		);
		expect(result).toHaveLength(2);
		expect(result[0].map((f) => f.fileId)).toEqual(['a', 'b']);
		expect(result[1].map((f) => f.fileId)).toEqual(['c']);
	});

	it('does not mutate the input array', () => {
		const files = [makeFile('a', 60), makeFile('b', 60)];
		binPackFiles(files, 100);
		expect(files).toHaveLength(2);
	});
});

// ── assignFilenames ───────────────────────────────────────────────────────

describe('assignFilenames', () => {
	it('assigns zipName based on batch index (1-based)', () => {
		const batches = [
			[makeFile('f1', 10, { submissionIndex: 0, submissionType: 'WEBPAGE', fieldName: 'evidence' })],
			[makeFile('f2', 10, { submissionIndex: 1, submissionType: 'WEBPAGE', fieldName: 'evidence' })]
		];
		const result = assignFilenames(batches, 2, '2026-03-21');
		expect(result.get('f1')?.zipName).toBe('export-2026-03-21-part1');
		expect(result.get('f2')?.zipName).toBe('export-2026-03-21-part2');
	});

	it('returns a PackedFile entry for every file', () => {
		const batches = [
			[makeFile('a', 10), makeFile('b', 10)],
			[makeFile('c', 10)]
		];
		const result = assignFilenames(batches, 10, '2026-01-01');
		expect(result.size).toBe(3);
		expect(result.has('a')).toBe(true);
		expect(result.has('b')).toBe(true);
		expect(result.has('c')).toBe(true);
	});

	it('disambiguates files with the same submissionId+fieldName globally across batches', () => {
		// Two files for sub-1/evidence — one in each batch
		const batches = [
			[makeFile('f1', 10, { submissionId: 'sub-1', fieldName: 'evidence', submissionIndex: 0 })],
			[makeFile('f2', 10, { submissionId: 'sub-1', fieldName: 'evidence', submissionIndex: 0 })]
		];
		const result = assignFilenames(batches, 10, '2026-01-01');
		const f1 = result.get('f1')!;
		const f2 = result.get('f2')!;
		// f1 is first → no suffix; f2 is second → suffix '-2'
		expect(f1.filename).not.toContain('-2');
		expect(f2.filename).toContain('-2');
	});

	it('different fieldNames on same submission do not interfere', () => {
		const batches = [[
			makeFile('f1', 10, { submissionId: 'sub-1', fieldName: 'screenshot', submissionIndex: 0 }),
			makeFile('f2', 10, { submissionId: 'sub-1', fieldName: 'notes', submissionIndex: 0 })
		]];
		const result = assignFilenames(batches, 10, '2026-01-01');
		// Neither should have a '-2' suffix
		expect(result.get('f1')!.filename).not.toContain('-2');
		expect(result.get('f2')!.filename).not.toContain('-2');
	});
});

// ── generateCsv ───────────────────────────────────────────────────────────

function makeSub(overrides: Partial<CsvSubmission> & { id: string }): CsvSubmission {
	return {
		type: 'WEBPAGE',
		createdAt: '2026-01-01T00:00:00Z',
		contentDate: null,
		archiveUrl: null,
		fileCount: 0,
		fields: {},
		...overrides
	};
}

describe('generateCsv', () => {
	it('produces a header row', () => {
		const csv = generateCsv([makeSub({ id: 'a' })], [], new Map(), new Map());
		const [header] = csv.split('\r\n');
		expect(header).toBe('id,type,submittedAt,contentDate,archiveUrl,fileCount,files');
	});

	it('includes one data row per submission', () => {
		const csv = generateCsv(
			[makeSub({ id: 'a' }), makeSub({ id: 'b' })],
			[],
			new Map(),
			new Map()
		);
		const lines = csv.split('\r\n').filter(Boolean);
		expect(lines).toHaveLength(3); // header + 2 rows
	});

	it('includes form field columns by label', () => {
		const fields: CsvFormField[] = [{ id: 'f1', label: 'URL' }, { id: 'f2', label: 'Notes' }];
		const sub = makeSub({ id: 'a', fields: { custom_f1: 'https://x.com', custom_f2: 'note' } });
		const csv = generateCsv([sub], fields, new Map(), new Map());
		const [header, row] = csv.split('\r\n');
		expect(header).toContain('URL');
		expect(header).toContain('Notes');
		expect(row).toContain('https://x.com');
		expect(row).toContain('note');
	});

	it('populates files column with zipName/filename paths', () => {
		const { PackedFile: _ignore, ...rest } = {} as { PackedFile: unknown };
		void _ignore; void rest;

		const fileAssignments = new Map([
			['fid1', {
				submissionId: 'sub-a', fileId: 'fid1', fieldName: 'evidence',
				mimeType: 'image/jpeg', sizeBytes: 100, submissionIndex: 0,
				submissionType: 'WEBPAGE',
				zipName: 'export-2026-01-01-part1', filename: '01-webpage-evidence.jpg'
			}]
		]);
		const filesBySubmission = new Map([['sub-a', ['fid1']]]);
		const sub = makeSub({ id: 'sub-a', fileCount: 1 });

		const csv = generateCsv([sub], [], fileAssignments, filesBySubmission);
		const row = csv.split('\r\n')[1];
		expect(row).toContain('export-2026-01-01-part1/01-webpage-evidence.jpg');
	});

	it('semicolon-separates multiple files in the files column', () => {
		const fileAssignments = new Map([
			['f1', { submissionId: 'sub-a', fileId: 'f1', fieldName: 'evidence', mimeType: null, sizeBytes: 10, submissionIndex: 0, submissionType: 'WEBPAGE', zipName: 'export-part1', filename: '01-webpage-evidence' }],
			['f2', { submissionId: 'sub-a', fileId: 'f2', fieldName: 'evidence', mimeType: null, sizeBytes: 10, submissionIndex: 0, submissionType: 'WEBPAGE', zipName: 'export-part1', filename: '01-webpage-evidence-2' }]
		]);
		const filesBySubmission = new Map([['sub-a', ['f1', 'f2']]]);
		const csv = generateCsv([makeSub({ id: 'sub-a', fileCount: 2 })], [], fileAssignments, filesBySubmission);
		const row = csv.split('\r\n')[1];
		expect(row).toContain('export-part1/01-webpage-evidence;export-part1/01-webpage-evidence-2');
	});

	it('wraps cells containing commas in double quotes', () => {
		const sub = makeSub({ id: 'a', fields: { custom_f1: 'value,with,commas' } });
		const fields: CsvFormField[] = [{ id: 'f1', label: 'Field' }];
		const csv = generateCsv([sub], fields, new Map(), new Map());
		expect(csv).toContain('"value,with,commas"');
	});

	it('escapes double quotes by doubling them', () => {
		const sub = makeSub({ id: 'a', fields: { custom_f1: 'say "hello"' } });
		const fields: CsvFormField[] = [{ id: 'f1', label: 'Field' }];
		const csv = generateCsv([sub], fields, new Map(), new Map());
		expect(csv).toContain('"say ""hello"""');
	});

	it('leaves files column empty for submissions without files', () => {
		const csv = generateCsv([makeSub({ id: 'a', fileCount: 0 })], [], new Map(), new Map());
		const row = csv.split('\r\n')[1];
		// Last cell (files) should be empty
		expect(row.endsWith(',')).toBe(true);
	});

	it('uses CRLF line endings and ends with a newline', () => {
		const csv = generateCsv([makeSub({ id: 'a' })], [], new Map(), new Map());
		expect(csv).toContain('\r\n');
		expect(csv.endsWith('\r\n')).toBe(true);
	});
});
