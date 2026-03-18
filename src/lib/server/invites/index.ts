import { randomBytes } from 'node:crypto';
import type { PrismaClient, Role } from '$lib/server/prisma/client';
import { logger } from '$lib/server/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InviteInfo {
	projectId: string;
	projectName: string;
	role: Role;
}

export interface CreateInviteData {
	projectId: string;
	role: Role;
	maxUses?: number | null;
	expiresAt?: Date | null;
	/** Null for admin-generated links. */
	createdBy?: string | null;
	creatorSignature?: string | null;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class InviteError extends Error {
	constructor(
		public readonly statusCode: 404 | 410,
		message: string
	) {
		super(message);
		this.name = 'InviteError';
	}
}

// ── Internal helper ───────────────────────────────────────────────────────────

function assertInviteUsable(
	invite: { expiresAt: Date | null; maxUses: number | null; usedCount: number } | null
): void {
	if (!invite) throw new InviteError(404, 'Invite link not found');

	if (invite.expiresAt && invite.expiresAt < new Date()) {
		throw new InviteError(410, 'This invite link has expired.');
	}

	if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
		throw new InviteError(410, 'This invite link has already been used.');
	}
}

// ── Service functions ─────────────────────────────────────────────────────────

/**
 * Returns project info for a valid invite token without consuming it.
 * Throws InviteError with 404 or 410 for invalid/expired/used tokens.
 */
export async function getInviteInfo(token: string, db: PrismaClient): Promise<InviteInfo> {
	const invite = await db.inviteLink.findUnique({
		where: { token },
		include: { project: true }
	});

	assertInviteUsable(invite);

	return {
		projectId: invite!.projectId,
		projectName: invite!.project.name,
		role: invite!.role
	};
}

/**
 * Validates and consumes an invite link, incrementing its used_count.
 * Returns the project ID on success.
 * Throws InviteError with 404 or 410 for invalid/expired/used tokens.
 * The used_count is NOT incremented for rejected claims.
 */
export async function claimInvite(token: string, db: PrismaClient): Promise<string> {
	const invite = await db.inviteLink.findUnique({
		where: { token },
		include: { project: true }
	});

	assertInviteUsable(invite);

	await db.inviteLink.update({
		where: { token },
		data: { usedCount: { increment: 1 } }
	});

	logger.info({ inviteId: invite!.id, projectId: invite!.projectId }, 'Invite link claimed');
	return invite!.projectId;
}

/**
 * Creates a new invite link for the given project.
 * Returns the full InviteLink record including the generated token.
 */
export async function createInvite(data: CreateInviteData, db: PrismaClient) {
	const token = randomBytes(32).toString('base64url');

	const invite = await db.inviteLink.create({
		data: {
			token,
			projectId: data.projectId,
			role: data.role,
			maxUses: data.maxUses ?? null,
			expiresAt: data.expiresAt ?? null,
			createdBy: data.createdBy ?? null,
			creatorSignature: data.creatorSignature ?? null
		}
	});

	logger.info(
		{ inviteId: invite.id, projectId: data.projectId, role: data.role },
		'Invite link created'
	);
	return invite;
}
