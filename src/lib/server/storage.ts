/**
 * Storage backend abstraction for encrypted submission files.
 *
 * By default files are stored on the local filesystem (under `./uploads/`).
 * Set the S3_* environment variables to use any S3-compatible object store
 * (AWS S3, Hetzner Object Storage, MinIO, etc.) instead.
 *
 * The `storagePath` column in `submission_files` is treated as an opaque key
 * by this module — the local backend maps it to a filesystem path and the S3
 * backend uses it directly as an object key.
 *
 * Required env vars for S3:
 *   S3_ENDPOINT         e.g. https://fsn1.your-objectstorage.com
 *   S3_BUCKET           bucket name
 *   S3_ACCESS_KEY_ID
 *   S3_SECRET_ACCESS_KEY
 *
 * Optional:
 *   S3_REGION           defaults to "auto"
 */

import { env } from '$env/dynamic/private';

// ── Backend interface ────────────────────────────────────────────────────────

export interface StorageBackend {
	/** Write bytes to the store and return the opaque storage key. */
	write(key: string, data: Uint8Array): Promise<void>;
	/** Read bytes from the store by their opaque storage key. */
	read(key: string): Promise<Uint8Array>;
	/** Delete a stored object. Best-effort; never throws. */
	delete(key: string): Promise<void>;
}

// ── Local filesystem backend ─────────────────────────────────────────────────

import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';

export class LocalBackend implements StorageBackend {
	async write(key: string, data: Uint8Array): Promise<void> {
		const path = join('uploads', key);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, data);
	}

	async read(key: string): Promise<Uint8Array> {
		// Support legacy paths stored before this abstraction was introduced:
		// absolute paths (any OS) or keys already prefixed with 'uploads/'.
		const isLegacyPath = isAbsolute(key) || key.startsWith('uploads/') || key.startsWith('uploads\\');
		const path = isLegacyPath ? key : join('uploads', key);
		return new Uint8Array(await readFile(path));
	}

	async delete(key: string): Promise<void> {
		const isLegacyPath = isAbsolute(key) || key.startsWith('uploads/') || key.startsWith('uploads\\');
		const path = isLegacyPath ? key : join('uploads', key);
		await rm(path, { force: true });
	}
}

// ── S3-compatible backend ────────────────────────────────────────────────────

import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand
} from '@aws-sdk/client-s3';

export class S3Backend implements StorageBackend {
	private client: S3Client;
	private bucket: string;

	constructor(endpoint: string, bucket: string, accessKeyId: string, secretAccessKey: string, region: string) {
		this.bucket = bucket;
		this.client = new S3Client({
			endpoint,
			region,
			credentials: { accessKeyId, secretAccessKey },
			// Hetzner (and most S3-compatible stores) use path-style URLs
			forcePathStyle: true
		});
	}

	async write(key: string, data: Uint8Array): Promise<void> {
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: key,
				Body: data,
				ContentType: 'application/octet-stream'
			})
		);
	}

	async read(key: string): Promise<Uint8Array> {
		const res = await this.client.send(
			new GetObjectCommand({ Bucket: this.bucket, Key: key })
		);
		if (!res.Body) throw new Error(`S3 object ${key} has no body`);
		// Body is a readable stream in Node.js; collect it into a buffer.
		const chunks: Uint8Array[] = [];
		for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
			chunks.push(chunk);
		}
		const total = chunks.reduce((n, c) => n + c.length, 0);
		const out = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return out;
	}

	async delete(key: string): Promise<void> {
		await this.client.send(
			new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
		).catch(() => {}); // best-effort
	}
}

// ── Active backend (singleton) ───────────────────────────────────────────────

function createBackend(): StorageBackend {
	const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION } = env;

	if (S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY) {
		return new S3Backend(
			S3_ENDPOINT,
			S3_BUCKET,
			S3_ACCESS_KEY_ID,
			S3_SECRET_ACCESS_KEY,
			S3_REGION ?? 'auto'
		);
	}

	return new LocalBackend();
}

export const storage: StorageBackend = createBackend();

/** Generate the storage key for a new file upload. */
export function makeStorageKey(projectId: string, submissionId: string, fileId: string): string {
	return `${projectId}/${submissionId}/${fileId}.enc`;
}
