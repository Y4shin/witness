import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import InviteManager from './InviteManager.svelte';

vi.mock('$lib/client/api', () => ({
	ApiError: class extends Error {
		status: number;
		constructor(status: number, message: string) {
			super(message);
			this.status = status;
			this.name = 'ApiError';
		}
	},
	api: {
		invites: {
			listForProject: vi.fn(),
			create: vi.fn(),
			revoke: vi.fn()
		}
	}
}));

import { api } from '$lib/client/api';

const mockInvites = [
	{
		id: 'inv-1',
		token: 'tok-abc',
		role: 'SUBMITTER',
		maxUses: 5,
		usedCount: 2,
		expiresAt: null,
		createdAt: new Date().toISOString()
	},
	{
		id: 'inv-2',
		token: 'tok-xyz',
		role: 'MODERATOR',
		maxUses: null,
		usedCount: 0,
		expiresAt: null,
		createdAt: new Date().toISOString()
	}
];

beforeEach(() => {
	vi.clearAllMocks();
	(api.invites.listForProject as ReturnType<typeof vi.fn>).mockResolvedValue({ invites: [] });
});

describe('InviteManager', () => {
	// ── happy path ───────────────────────────────────────────────────────────

	it('renders role selector with SUBMITTER and MODERATOR options', async () => {
		render(InviteManager, { projectId: 'proj-1' });
		await expect.element(page.getByRole('combobox', { name: 'Role' })).toBeVisible();
		const select = page.getByRole('combobox', { name: 'Role' }).element() as HTMLSelectElement;
		const options = Array.from(select.options).map((o) => o.value);
		expect(options).toContain('SUBMITTER');
		expect(options).toContain('MODERATOR');
	});

	it('renders max uses input', async () => {
		render(InviteManager, { projectId: 'proj-1' });
		await expect.element(page.getByLabelText('Max uses')).toBeVisible();
	});

	it('renders expiry date-time input', async () => {
		render(InviteManager, { projectId: 'proj-1' });
		await expect.element(page.getByLabelText('Expires at')).toBeVisible();
	});

	it('renders create button', async () => {
		render(InviteManager, { projectId: 'proj-1' });
		await expect.element(page.getByLabelText('Create invite link')).toBeVisible();
	});

	it('shows loaded invite cards', async () => {
		(api.invites.listForProject as ReturnType<typeof vi.fn>).mockResolvedValue({ invites: mockInvites });
		render(InviteManager, { projectId: 'proj-1' });
		await expect.poll(() =>
			document.querySelectorAll('[data-testid="invite-card"]').length
		).toBe(2);
	});

	it('shows "no active invite links" when list is empty', async () => {
		(api.invites.listForProject as ReturnType<typeof vi.fn>).mockResolvedValue({ invites: [] });
		render(InviteManager, { projectId: 'proj-1' });
		await expect.element(page.getByText('No active invite links.')).toBeVisible();
	});

	it('calls api.invites.create with correct role when form is submitted', async () => {
		(api.invites.create as ReturnType<typeof vi.fn>).mockResolvedValue({ token: 'new-tok' });
		(api.invites.listForProject as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ invites: [] })
			.mockResolvedValue({ invites: [] });

		render(InviteManager, { projectId: 'proj-1' });

		// Switch to MODERATOR
		await page.getByLabelText('Role').selectOptions('MODERATOR');
		await page.getByRole('button', { name: 'Create invite link' }).click();

		await expect.poll(() => (api.invites.create as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
		expect(api.invites.create).toHaveBeenCalledWith(
			expect.objectContaining({ role: 'MODERATOR', projectId: 'proj-1' })
		);
	});

	it('calls api.invites.revoke when revoke button is clicked', async () => {
		(api.invites.listForProject as ReturnType<typeof vi.fn>).mockResolvedValue({ invites: [mockInvites[0]] });
		(api.invites.revoke as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

		render(InviteManager, { projectId: 'proj-1' });
		await expect.poll(() => document.querySelectorAll('[data-testid="invite-card"]').length).toBe(1);

		await page.getByRole('button', { name: `Revoke invite ${mockInvites[0].token}` }).click();

		await expect.poll(() => (api.invites.revoke as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
		expect(api.invites.revoke).toHaveBeenCalledWith(mockInvites[0].token);
	});

	it('removes invite card from list after successful revoke', async () => {
		(api.invites.listForProject as ReturnType<typeof vi.fn>).mockResolvedValue({ invites: mockInvites });
		(api.invites.revoke as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

		render(InviteManager, { projectId: 'proj-1' });
		await expect.poll(() => document.querySelectorAll('[data-testid="invite-card"]').length).toBe(2);

		await page.getByRole('button', { name: `Revoke invite ${mockInvites[0].token}` }).click();
		await expect.poll(() => document.querySelectorAll('[data-testid="invite-card"]').length).toBe(1);
	});

	// ── non-happy path ────────────────────────────────────────────────────────

	it('calls api.invites.create and shows error on rejection', async () => {
		(api.invites.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Server error'));
		render(InviteManager, { projectId: 'proj-1' });

		const btn = document.querySelector('[data-testid="create-invite-btn"]') as HTMLButtonElement;
		await expect.poll(() => btn !== null, { timeout: 3000 }).toBeTruthy();
		btn.click();

		// Verify create was called
		await expect.poll(() =>
			(api.invites.create as ReturnType<typeof vi.fn>).mock.calls.length > 0
		, { timeout: 5000 }).toBeTruthy();
		// Verify error state in DOM (uses fallback message for non-ApiError)
		await expect.poll(() =>
			document.querySelector('[role="alert"]') !== null
		, { timeout: 5000 }).toBeTruthy();
	});

	it('shows error when listForProject fails', async () => {
		(api.invites.listForProject as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Load failed'));
		render(InviteManager, { projectId: 'proj-1' });
		// The component converts non-ApiError to a fallback message
		await expect.poll(() => {
			const alert = document.querySelector('[role="alert"]');
			return alert !== null;
		}, { timeout: 5000 }).toBeTruthy();
	});
});
