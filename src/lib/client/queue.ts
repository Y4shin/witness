/**
 * Offline submission queue backed by IndexedDB.
 *
 * Submissions made while offline are stored here (fully encrypted, but
 * without a nonce/signature). At sync time the caller fetches a fresh
 * nonce, signs, and posts each item to the server.
 *
 * type, archiveCandidateUrl, and archiveUrl live inside encryptedPayload
 * (as DecryptedPayload) — they are never stored in plaintext here.
 */
import { openCacheDb, PENDING_STORE } from '$lib/stores/cache';

export interface PendingFile {
	fieldName: string;
	/** AES-GCM ciphertext of { mimeType } JSON, encrypted with per-file key */
	encryptedMeta: string;
	/** base64url AES-GCM encrypted bytes — identical to UploadFileRequest.encryptedData */
	encryptedData: string;
	/** JSON-serialised EncryptedKey for the project */
	encryptedKey: string;
	/** JSON-serialised EncryptedKey for the submitter */
	encryptedKeyUser: string;
}

export interface PendingSubmission {
	id: string;
	projectId: string;
	/** base64url AES-GCM ciphertext of DecryptedPayload JSON */
	encryptedPayload: string;
	encryptedKeyProject: string;
	encryptedKeyUser: string;
	files: PendingFile[];
	queuedAt: string;
}

// Lazily opened DB singleton
let dbPromise: Promise<IDBDatabase> | null = null;
function getDb(): Promise<IDBDatabase> {
	if (!dbPromise) dbPromise = openCacheDb();
	return dbPromise;
}

export async function enqueue(
	entry: Omit<PendingSubmission, 'id' | 'queuedAt'>
): Promise<string> {
	const id = crypto.randomUUID();
	const record: PendingSubmission = { ...entry, id, queuedAt: new Date().toISOString() };
	const db = await getDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(PENDING_STORE, 'readwrite');
		const req = tx.objectStore(PENDING_STORE).put(record);
		req.onsuccess = () => resolve(id);
		req.onerror = () => reject(req.error);
	});
}

export async function listPending(): Promise<PendingSubmission[]> {
	const db = await getDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(PENDING_STORE, 'readonly');
		const req = tx.objectStore(PENDING_STORE).getAll();
		req.onsuccess = () =>
			resolve(
				(req.result as PendingSubmission[]).sort(
					(a, b) => a.queuedAt.localeCompare(b.queuedAt)
				)
			);
		req.onerror = () => reject(req.error);
	});
}

export async function removePending(id: string): Promise<void> {
	const db = await getDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(PENDING_STORE, 'readwrite');
		const req = tx.objectStore(PENDING_STORE).delete(id);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
	});
}

export async function countPending(): Promise<number> {
	const db = await getDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(PENDING_STORE, 'readonly');
		const req = tx.objectStore(PENDING_STORE).count();
		req.onsuccess = () => resolve(req.result as number);
		req.onerror = () => reject(req.error);
	});
}
