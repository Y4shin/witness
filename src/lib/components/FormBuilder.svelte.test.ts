import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock BEFORE importing the component so the module graph uses the mock.
vi.mock('$lib/client/api', () => ({
	ApiError: class extends Error {
		status: number;
		constructor(status: number, message: string) {
			super(message);
			this.status = status;
		}
	},
	api: {
		fields: {
			create: vi.fn(),
			delete: vi.fn(),
			reorder: vi.fn()
		}
	}
}));

import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { api } from '$lib/client/api';
import FormBuilder from './FormBuilder.svelte';
import type { FormField } from '$lib/api-types';

function makeField(overrides: Partial<FormField> = {}): FormField {
	return {
		id: crypto.randomUUID(),
		projectId: 'proj-1',
		label: 'Test field',
		type: 'TEXT',
		options: null,
		required: false,
		sortOrder: 0,
		createdAt: new Date().toISOString(),
		...overrides
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('FormBuilder', () => {
	// ── happy path ──────────────────────────────────────────────────────────

	it('adding a TEXT field appears in the list', async () => {
		const created = makeField({ id: 'new-1', label: 'Full name' });
		vi.mocked(api.fields.create).mockResolvedValueOnce({ field: created });

		render(FormBuilder, { projectId: 'proj-1', fields: [] });

		await page.getByLabelText('Field label').fill('Full name');
		await page.getByRole('button', { name: 'Add field' }).click();

		await expect.element(page.getByText('Full name')).toBeVisible();
		expect(api.fields.create).toHaveBeenCalledOnce();
	});

	it('shows options input when SELECT type is chosen', async () => {
		render(FormBuilder, { projectId: 'proj-1', fields: [] });

		// No options input initially (TEXT is the default)
		expect(page.getByLabelText('Options').elements()).toHaveLength(0);

		await page.getByLabelText('Field type').selectOptions('SELECT');

		await expect.element(page.getByLabelText('Options')).toBeVisible();
	});

	it('options input is hidden again when type changes away from SELECT', async () => {
		render(FormBuilder, { projectId: 'proj-1', fields: [] });

		await page.getByLabelText('Field type').selectOptions('SELECT');
		await expect.element(page.getByLabelText('Options')).toBeVisible();

		await page.getByLabelText('Field type').selectOptions('TEXT');
		expect(page.getByLabelText('Options').elements()).toHaveLength(0);
	});

	it('reordering moves a field up in the displayed list', async () => {
		const alpha = makeField({ id: 'a', label: 'Alpha', sortOrder: 0 });
		const beta = makeField({ id: 'b', label: 'Beta', sortOrder: 1 });
		vi.mocked(api.fields.reorder).mockResolvedValue({ field: alpha });

		render(FormBuilder, { projectId: 'proj-1', fields: [alpha, beta] });

		await page.getByLabelText('Move Beta up').click();

		// Beta should now appear first
		const items = page.getByRole('listitem');
		await expect.element(items.nth(0)).toHaveTextContent('Beta');
		await expect.element(items.nth(1)).toHaveTextContent('Alpha');
	});

	it('initial fields are displayed', async () => {
		const field = makeField({ label: 'Email' });
		render(FormBuilder, { projectId: 'proj-1', fields: [field] });

		await expect.element(page.getByText('Email')).toBeVisible();
	});

	it('deleting a field removes it from the list', async () => {
		const field = makeField({ label: 'To delete' });
		vi.mocked(api.fields.delete).mockResolvedValueOnce({ ok: true });

		render(FormBuilder, { projectId: 'proj-1', fields: [field] });
		await page.getByLabelText('Delete To delete').click();

		await expect.element(page.getByText('To delete')).not.toBeInTheDocument();
	});

	// ── non-happy path ───────────────────────────────────────────────────────

	it('shows validation error when SELECT field has no options', async () => {
		render(FormBuilder, { projectId: 'proj-1', fields: [] });

		await page.getByLabelText('Field label').fill('Category');
		await page.getByLabelText('Field type').selectOptions('SELECT');
		// Leave options input empty
		await page.getByRole('button', { name: 'Add field' }).click();

		await expect.element(page.getByRole('alert')).toBeVisible();
		await expect.element(page.getByRole('alert')).toHaveTextContent(/option/i);
		expect(api.fields.create).not.toHaveBeenCalled();
	});

	it('shows validation error when label is empty', async () => {
		render(FormBuilder, { projectId: 'proj-1', fields: [] });

		// Leave label empty, click Add
		await page.getByRole('button', { name: 'Add field' }).click();

		await expect.element(page.getByRole('alert')).toBeVisible();
		expect(api.fields.create).not.toHaveBeenCalled();
	});

	it('clears validation error after successful add', async () => {
		const created = makeField({ label: 'Name' });
		vi.mocked(api.fields.create).mockResolvedValueOnce({ field: created });

		render(FormBuilder, { projectId: 'proj-1', fields: [] });

		// Trigger validation error
		await page.getByRole('button', { name: 'Add field' }).click();
		await expect.element(page.getByRole('alert')).toBeVisible();

		// Now fill and succeed
		await page.getByLabelText('Field label').fill('Name');
		await page.getByRole('button', { name: 'Add field' }).click();

		await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
	});
});
