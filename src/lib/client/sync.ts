/**
 * Drains the offline submission queue.
 *
 * For each pending submission:
 *  1. Fetch a fresh single-use nonce from the server.
 *  2. Sign SHA-256(encryptedPayload) || nonce with the user's ECDSA key.
 *  3. POST the submission to the server.
 *  4. Upload any queued files.
 *  5. Remove the item from the queue.
 *
 * Failed items are left in the queue and retried on the next sync.
 */
import { api } from '$lib/client/api';
import { sign } from '$lib/crypto';
import { listPending, removePending } from '$lib/client/queue';

export async function syncPendingSubmissions(
	signingKey: CryptoKey
): Promise<{ synced: number; failed: number }> {
	const pending = await listPending();
	let synced = 0;
	let failed = 0;

	for (const item of pending) {
		try {
			// 1. Fresh nonce (single-use, 5-min TTL)
			const { nonce } = await api.auth.challenge();

			// 2. Sign nonce_bytes || SHA-256(encryptedPayload)
			const nonceBytes = new TextEncoder().encode(nonce);
			const payloadBytes = new TextEncoder().encode(item.encryptedPayload);
			const sha256bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', payloadBytes));
			const message = new Uint8Array(nonceBytes.length + sha256bytes.length);
			message.set(nonceBytes);
			message.set(sha256bytes, nonceBytes.length);
			const submitterSignature = await sign(signingKey, message);

			// 3. POST submission
			const { submissionId } = await api.submissions.create({
				projectId: item.projectId,
				type: item.type,
				archiveCandidateUrl: item.archiveCandidateUrl ?? null,
				encryptedPayload: item.encryptedPayload,
				encryptedKeyProject: item.encryptedKeyProject,
				encryptedKeyUser: item.encryptedKeyUser,
				submitterSignature,
				nonce
			});

			// 4. Upload files sequentially
			for (const f of item.files) {
				await api.submissions.uploadFile(submissionId, {
					fieldName: f.fieldName,
					mimeType: f.mimeType,
					encryptedData: f.encryptedData,
					encryptedKey: f.encryptedKey,
					encryptedKeyUser: f.encryptedKeyUser
				});
			}

			// 5. Remove from queue on success
			await removePending(item.id);
			synced++;
		} catch {
			// Leave the item in the queue for the next sync attempt
			failed++;
		}
	}

	return { synced, failed };
}
