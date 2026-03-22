/**
 * Unit tests for storage backends and helpers.
 *
 * LocalBackend  — exercises real filesystem I/O in a temp directory.
 * S3Backend     — mocks @aws-sdk/client-s3; verifies commands sent and
 *                 that the response body stream is correctly reassembled.
 * makeStorageKey — key format contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ── S3 SDK mock ──────────────────────────────────────────────────────────────
// vi.hoisted ensures mockSend is initialised before vi.mock's factory runs
// (vi.mock is hoisted to the top of the file by the Vitest transformer).

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3', () => ({
	// Must be a class/function so `new S3Client(...)` works.
	S3Client: class {
		send = mockSend;
	},
	PutObjectCommand: class {
		_cmd = 'Put';
		constructor(public input: unknown) {}
	},
	GetObjectCommand: class {
		_cmd = 'Get';
		constructor(public input: unknown) {}
	},
	DeleteObjectCommand: class {
		_cmd = 'Delete';
		constructor(public input: unknown) {}
	}
}));

// Also mock $env/dynamic/private — not used by the classes directly but
// imported at the top of storage.ts for createBackend().
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { LocalBackend, S3Backend, makeStorageKey } from './storage';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build an AsyncIterable<Uint8Array> that yields the supplied chunks. */
function makeS3Body(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
	return {
		[Symbol.asyncIterator]: async function* () {
			for (const chunk of chunks) yield chunk;
		}
	};
}

// ── LocalBackend ─────────────────────────────────────────────────────────────

describe('LocalBackend', () => {
	let tmpBase: string;
	let backend: LocalBackend;

	beforeEach(async () => {
		// Each test gets its own temp directory so tests are fully isolated.
		tmpBase = join(tmpdir(), `rt-storage-test-${randomUUID()}`);
		await mkdir(tmpBase, { recursive: true });
		// Point the backend at the temp dir by temporarily overriding process.cwd.
		// LocalBackend prepends 'uploads/' to keys; we change cwd so that resolves
		// inside our temp directory rather than the project root.
		vi.spyOn(process, 'cwd').mockReturnValue(tmpBase);
		backend = new LocalBackend();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(tmpBase, { recursive: true, force: true });
	});

	it('write then read returns identical bytes', async () => {
		const key = 'proj/sub/file.enc';
		const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		await backend.write(key, data);
		const result = await backend.read(key);
		expect(result).toEqual(data);
	});

	it('write creates intermediate directories', async () => {
		const key = 'a/b/c/deeply/nested/file.enc';
		const data = new Uint8Array([1, 2, 3]);
		await expect(backend.write(key, data)).resolves.not.toThrow();
		const result = await backend.read(key);
		expect(result).toEqual(data);
	});

	it('read throws when key does not exist', async () => {
		await expect(backend.read('nonexistent/file.enc')).rejects.toThrow();
	});

	it('delete removes the file', async () => {
		const key = 'proj/sub/to-delete.enc';
		await backend.write(key, new Uint8Array([1]));
		await backend.delete(key);
		await expect(backend.read(key)).rejects.toThrow();
	});

	it('delete is silent when the file does not exist', async () => {
		await expect(backend.delete('missing/file.enc')).resolves.not.toThrow();
	});

	it('overwrites existing content on write', async () => {
		const key = 'proj/sub/overwrite.enc';
		await backend.write(key, new Uint8Array([0x01]));
		const updated = new Uint8Array([0x02, 0x03]);
		await backend.write(key, updated);
		expect(await backend.read(key)).toEqual(updated);
	});

	describe('legacy path support', () => {
		it('reads an absolute path directly', async () => {
			// Simulate a record created before the storage abstraction
			const absPath = join(tmpBase, 'legacy-abs.enc');
			const { writeFile } = await import('node:fs/promises');
			const data = new Uint8Array([0xca, 0xfe]);
			await writeFile(absPath, data);
			const result = await backend.read(absPath);
			expect(result).toEqual(data);
		});

		it('reads a relative path starting with uploads/', async () => {
			// Write via the new API so the file is at <tmpBase>/uploads/proj/sub/x.enc
			const key = 'proj/sub/legacy-rel.enc';
			const data = new Uint8Array([0xba, 0xbe]);
			await backend.write(key, data);
			// Now read using the old-style 'uploads/...' prefix
			const legacyKey = `uploads/${key}`;
			const result = await backend.read(legacyKey);
			expect(result).toEqual(data);
		});
	});
});

// ── S3Backend ────────────────────────────────────────────────────────────────

describe('S3Backend', () => {
	const BUCKET = 'test-bucket';
	let backend: S3Backend;

	beforeEach(() => {
		mockSend.mockReset();
		backend = new S3Backend(
			'https://s3.example.com',
			BUCKET,
			'access-key',
			'secret-key',
			'auto'
		);
	});

	describe('write', () => {
		it('sends a PutObjectCommand with the correct bucket, key, and body', async () => {
			mockSend.mockResolvedValueOnce({});
			const data = new Uint8Array([1, 2, 3]);
			await backend.write('proj/sub/file.enc', data);

			expect(mockSend).toHaveBeenCalledOnce();
			const [cmd] = mockSend.mock.calls[0];
			expect(cmd._cmd).toBe('Put');
			expect(cmd.input).toMatchObject({
				Bucket: BUCKET,
				Key: 'proj/sub/file.enc',
				Body: data,
				ContentType: 'application/octet-stream'
			});
		});

		it('propagates S3 errors', async () => {
			mockSend.mockRejectedValueOnce(new Error('S3 error'));
			await expect(backend.write('k', new Uint8Array())).rejects.toThrow('S3 error');
		});
	});

	describe('read', () => {
		it('sends a GetObjectCommand and reassembles the body stream', async () => {
			const part1 = new Uint8Array([0x01, 0x02]);
			const part2 = new Uint8Array([0x03, 0x04, 0x05]);
			mockSend.mockResolvedValueOnce({ Body: makeS3Body(part1, part2) });

			const result = await backend.read('proj/sub/file.enc');

			expect(mockSend).toHaveBeenCalledOnce();
			const [cmd] = mockSend.mock.calls[0];
			expect(cmd._cmd).toBe('Get');
			expect(cmd.input).toMatchObject({ Bucket: BUCKET, Key: 'proj/sub/file.enc' });

			// All chunks must be concatenated in order
			expect(result).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]));
		});

		it('reassembles a single-chunk body correctly', async () => {
			const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
			mockSend.mockResolvedValueOnce({ Body: makeS3Body(bytes) });
			expect(await backend.read('k')).toEqual(bytes);
		});

		it('throws when the response has no Body', async () => {
			mockSend.mockResolvedValueOnce({ Body: null });
			await expect(backend.read('k')).rejects.toThrow();
		});

		it('propagates S3 errors', async () => {
			mockSend.mockRejectedValueOnce(new Error('not found'));
			await expect(backend.read('k')).rejects.toThrow('not found');
		});
	});

	describe('delete', () => {
		it('sends a DeleteObjectCommand with the correct bucket and key', async () => {
			mockSend.mockResolvedValueOnce({});
			await backend.delete('proj/sub/file.enc');

			expect(mockSend).toHaveBeenCalledOnce();
			const [cmd] = mockSend.mock.calls[0];
			expect(cmd._cmd).toBe('Delete');
			expect(cmd.input).toMatchObject({ Bucket: BUCKET, Key: 'proj/sub/file.enc' });
		});

		it('is silent when S3 returns an error (best-effort)', async () => {
			mockSend.mockRejectedValueOnce(new Error('no such key'));
			await expect(backend.delete('k')).resolves.not.toThrow();
		});
	});
});

// ── makeStorageKey ────────────────────────────────────────────────────────────

describe('makeStorageKey', () => {
	it('produces the expected path format', () => {
		expect(makeStorageKey('proj-1', 'sub-2', 'file-3')).toBe('proj-1/sub-2/file-3.enc');
	});

	it('always ends with .enc', () => {
		expect(makeStorageKey('a', 'b', 'c')).toMatch(/\.enc$/);
	});
});
