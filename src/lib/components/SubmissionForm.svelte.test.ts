import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import SubmissionForm from './SubmissionForm.svelte';
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

describe('SubmissionForm', () => {
	// ── happy path ──────────────────────────────────────────────────────────

	it('renders a text input for a TEXT field', async () => {
		const field = makeField({ label: 'Full name', type: 'TEXT' });
		render(SubmissionForm, { fields: [field], onsubmit: async () => {} });
		await expect.element(page.getByLabelText('Full name')).toBeVisible();
		// Should be a text input
		const el = page.getByLabelText('Full name').element() as HTMLInputElement;
		expect(el.tagName).toBe('INPUT');
		expect(el.type).toBe('text');
	});

	it('renders a select element for a SELECT field', async () => {
		const field = makeField({
			label: 'Category',
			type: 'SELECT',
			options: JSON.stringify(['Option A', 'Option B'])
		});
		render(SubmissionForm, { fields: [field], onsubmit: async () => {} });

		const el = page.getByLabelText('Category').element() as HTMLSelectElement;
		expect(el.tagName).toBe('SELECT');
		// Check options are rendered
		await expect.element(page.getByLabelText('Category')).toBeVisible();
	});

	it('renders a file input for a FILE field', async () => {
		const field = makeField({ label: 'Attachment', type: 'FILE' });
		render(SubmissionForm, { fields: [field], onsubmit: async () => {} });
		const el = page.getByLabelText('Attachment').element() as HTMLInputElement;
		expect(el.tagName).toBe('INPUT');
		expect(el.type).toBe('file');
	});

	it('submit button is enabled when there are no required fields', async () => {
		const field = makeField({ label: 'Optional', type: 'TEXT', required: false });
		render(SubmissionForm, { fields: [field], onsubmit: async () => {} });
		await expect.element(page.getByRole('button', { name: 'Submit' })).toBeEnabled();
	});

	it('submit button is disabled when a required field is empty', async () => {
		const field = makeField({ label: 'Required field', type: 'TEXT', required: true });
		render(SubmissionForm, { fields: [field], onsubmit: async () => {} });
		await expect.element(page.getByRole('button', { name: 'Submit' })).toBeDisabled();
	});

	it('submit button becomes enabled when a required field is filled', async () => {
		const field = makeField({ label: 'Required field', type: 'TEXT', required: true });
		render(SubmissionForm, { fields: [field], onsubmit: async () => {} });

		await page.getByLabelText('Required field').fill('some value');
		await expect.element(page.getByRole('button', { name: 'Submit' })).toBeEnabled();
	});

	it('calls onsubmit with form data when submitted', async () => {
		const onsubmit = vi.fn(async () => {});
		const field = makeField({ id: 'f1', label: 'Name', type: 'TEXT', required: true });
		render(SubmissionForm, { fields: [field], onsubmit });

		await page.getByLabelText('Name').fill('Alice');
		await page.getByRole('button', { name: 'Submit' }).click();

		await expect.poll(() => onsubmit.mock.calls.length).toBeGreaterThan(0);
		expect(onsubmit).toHaveBeenCalledWith(expect.objectContaining({ f1: 'Alice' }));
	});

	// ── non-happy path ───────────────────────────────────────────────────────

	it('does not call onsubmit when required field is empty', async () => {
		const onsubmit = vi.fn(async () => {});
		const field = makeField({ label: 'Required', type: 'TEXT', required: true });
		render(SubmissionForm, { fields: [field], onsubmit });

		// Button is disabled — click has no effect
		await expect.element(page.getByRole('button', { name: 'Submit' })).toBeDisabled();
		expect(onsubmit).not.toHaveBeenCalled();
	});

	it('shows error message when error prop is set', async () => {
		render(SubmissionForm, {
			fields: [],
			onsubmit: async () => {},
			error: 'Something went wrong'
		});
		await expect.element(page.getByRole('alert')).toHaveTextContent('Something went wrong');
	});

	it('does not show alert when error prop is empty', async () => {
		render(SubmissionForm, { fields: [], onsubmit: async () => {} });
		expect(page.getByRole('alert').elements()).toHaveLength(0);
	});

	it('submit button is disabled when disabled prop is true', async () => {
		const field = makeField({ label: 'Field', type: 'TEXT', required: false });
		render(SubmissionForm, { fields: [field], onsubmit: async () => {}, disabled: true });
		await expect.element(page.getByRole('button', { name: 'Submit' })).toBeDisabled();
	});

	it('whitespace-only required field keeps button disabled', async () => {
		const field = makeField({ label: 'Required', type: 'TEXT', required: true });
		render(SubmissionForm, { fields: [field], onsubmit: async () => {} });
		await page.getByLabelText('Required').fill('   ');
		await expect.element(page.getByRole('button', { name: 'Submit' })).toBeDisabled();
	});
});
