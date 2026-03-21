/**
 * Pure utility functions for the submission export feature.
 * Framework-free — all functions are fully unit-testable.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Metadata about a file that needs to be packed into a ZIP.
 * Does not include crypto keys — those stay in the orchestrator.
 */
export interface FileToPack {
	submissionId: string;
	fileId: string;
	fieldName: string;
	mimeType: string | null;
	/** Encrypted size in bytes (used for bin-packing; actual decrypted size is slightly smaller). */
	sizeBytes: number;
	/** 0-based index of the submission in the filtered list (for filename padding). */
	submissionIndex: number;
	submissionType: string;
}

/** A FileToPack with its assigned ZIP name and descriptive filename. */
export interface PackedFile extends FileToPack {
	/** ZIP archive name without extension, e.g. 'export-2026-03-21-part1' */
	zipName: string;
	/** Filename within the ZIP, e.g. '0042-webpage-evidence.jpg' */
	filename: string;
}

export interface CsvSubmission {
	id: string;
	type: string;
	createdAt: string;
	contentDate: string | null;
	archiveUrl: string | null;
	fileCount: number;
	fields: Record<string, string>;
}

export interface CsvFormField {
	id: string;
	label: string;
}

// ── MIME → extension ───────────────────────────────────────────────────────

const MIME_EXT: Record<string, string> = {
	'image/jpeg':       '.jpg',
	'image/jpg':        '.jpg',
	'image/png':        '.png',
	'image/gif':        '.gif',
	'image/webp':       '.webp',
	'image/svg+xml':    '.svg',
	'video/mp4':        '.mp4',
	'video/webm':       '.webm',
	'video/quicktime':  '.mov',
	'video/x-msvideo':  '.avi',
	'application/pdf':  '.pdf',
	'audio/mpeg':       '.mp3',
	'audio/ogg':        '.ogg',
	'audio/wav':        '.wav'
};

/** Returns the file extension (with leading dot) for a MIME type, or '' when unknown. */
export function mimeToExt(mimeType: string | null): string {
	return mimeType ? (MIME_EXT[mimeType] ?? '') : '';
}

// ── Descriptive filename ───────────────────────────────────────────────────

/**
 * Generates a human-readable filename for an exported file.
 *
 * Format: `{paddedIndex}-{type-slug}-{field-slug}{disambiguator}{ext}`
 *
 * Examples:
 *   (5, 200, 'YOUTUBE_VIDEO', 'evidence', 'video/mp4', 1) → '005-youtube-video-evidence.mp4'
 *   (5, 200, 'WEBPAGE',       'evidence', 'image/jpeg', 2) → '005-webpage-evidence-2.jpg'
 *
 * @param submissionIndex  0-based index in the filtered list
 * @param totalSubmissions total count (determines zero-padding width)
 * @param submissionType   e.g. 'WEBPAGE', 'YOUTUBE_VIDEO'
 * @param fieldName        e.g. 'evidence', 'screenshot'
 * @param mimeType         e.g. 'image/jpeg' or null
 * @param disambiguator    1-based; suffix `-N` is appended only when > 1
 */
export function descriptiveFilename(
	submissionIndex: number,
	totalSubmissions: number,
	submissionType: string,
	fieldName: string,
	mimeType: string | null,
	disambiguator: number
): string {
	const padWidth = Math.max(1, String(totalSubmissions).length);
	const padded = String(submissionIndex + 1).padStart(padWidth, '0');
	const typeSlug = submissionType.toLowerCase().replace(/_/g, '-');
	const nameSlug = fieldName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
	const suffix = disambiguator > 1 ? `-${disambiguator}` : '';
	return `${padded}-${typeSlug}-${nameSlug}${suffix}${mimeToExt(mimeType)}`;
}

// ── Bin-packing ────────────────────────────────────────────────────────────

/**
 * Greedily assigns files to ZIP batches so no batch exceeds `maxBytes`.
 * A single file larger than `maxBytes` gets its own batch (never skipped).
 * Input order is preserved within each batch.
 */
export function binPackFiles(files: FileToPack[], maxBytes: number): FileToPack[][] {
	const batches: FileToPack[][] = [];
	let current: FileToPack[] = [];
	let currentSize = 0;

	for (const file of files) {
		if (currentSize + file.sizeBytes > maxBytes && current.length > 0) {
			batches.push(current);
			current = [];
			currentSize = 0;
		}
		current.push(file);
		currentSize += file.sizeBytes;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

// ── Filename assignment ────────────────────────────────────────────────────

/**
 * Assigns each file a `zipName` and `filename`, returning a Map<fileId, PackedFile>.
 *
 * Disambiguators are counted globally across all batches so that two files
 * with the same (submissionId, fieldName) always get distinct names even
 * if they end up in different ZIPs.
 *
 * @param batches          output of binPackFiles
 * @param totalSubmissions total count of filtered submissions (for zero-padding)
 * @param datePrefix       e.g. '2026-03-21' — used in the ZIP name
 */
export function assignFilenames(
	batches: FileToPack[][],
	totalSubmissions: number,
	datePrefix: string
): Map<string, PackedFile> {
	const result = new Map<string, PackedFile>();
	// Global counter: (submissionId + fieldName) → how many times seen so far
	const fieldCount = new Map<string, number>();

	for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
		const zipName = `export-${datePrefix}-part${batchIndex + 1}`;

		for (const file of batches[batchIndex]) {
			const key = `${file.submissionId}:${file.fieldName}`;
			const count = (fieldCount.get(key) ?? 0) + 1;
			fieldCount.set(key, count);

			const filename = descriptiveFilename(
				file.submissionIndex,
				totalSubmissions,
				file.submissionType,
				file.fieldName,
				file.mimeType,
				count
			);

			result.set(file.fileId, { ...file, zipName, filename });
		}
	}

	return result;
}

// ── CSV generation ─────────────────────────────────────────────────────────

function csvCell(value: string | number | null | undefined): string {
	const s = value == null ? '' : String(value);
	if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
		return '"' + s.replace(/"/g, '""') + '"';
	}
	return s;
}

/**
 * Generates a UTF-8 CSV string for the filtered submissions.
 *
 * Layout:
 *   id, type, submittedAt, contentDate, archiveUrl, fileCount,
 *   [one column per non-FILE form field by label],
 *   files
 *
 * The `files` cell contains semicolon-separated `{zipName}/{filename}` paths
 * for each attached file (empty when none).
 *
 * @param submissions      ordered list of submissions to export
 * @param formFields       non-FILE form fields — each becomes a column
 * @param fileAssignments  Map<fileId, PackedFile> from assignFilenames
 * @param filesBySubmission Map<submissionId, fileId[]> built during planning
 */
export function generateCsv(
	submissions: CsvSubmission[],
	formFields: CsvFormField[],
	fileAssignments: Map<string, PackedFile>,
	filesBySubmission: Map<string, string[]>
): string {
	const headers = [
		'id', 'type', 'submittedAt', 'contentDate', 'archiveUrl', 'fileCount',
		...formFields.map((f) => f.label),
		'files'
	];

	const rows: string[] = [headers.map(csvCell).join(',')];

	for (const sub of submissions) {
		const fileIds = filesBySubmission.get(sub.id) ?? [];
		const filePaths = fileIds
			.map((fid) => {
				const pf = fileAssignments.get(fid);
				return pf ? `${pf.zipName}/${pf.filename}` : '';
			})
			.filter(Boolean);

		const cells = [
			csvCell(sub.id),
			csvCell(sub.type),
			csvCell(sub.createdAt),
			csvCell(sub.contentDate),
			csvCell(sub.archiveUrl),
			csvCell(sub.fileCount),
			...formFields.map((f) => csvCell(sub.fields[`custom_${f.id}`] ?? '')),
			csvCell(filePaths.join(';'))
		];

		rows.push(cells.join(','));
	}

	return rows.join('\r\n') + '\r\n';
}
