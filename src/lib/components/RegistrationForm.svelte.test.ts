import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import RegistrationForm from './RegistrationForm.svelte';

describe('RegistrationForm', () => {
	it('renders name and contact inputs', async () => {
		render(RegistrationForm, { onsubmit: () => {} });
		await expect.element(page.getByLabelText('Name')).toBeVisible();
		await expect.element(page.getByLabelText('Contact')).toBeVisible();
	});

	it('submit button is disabled when form is empty', async () => {
		render(RegistrationForm, { onsubmit: () => {} });
		await expect.element(page.getByRole('button', { name: 'Register' })).toBeDisabled();
	});

	it('submit button is disabled when only name is filled', async () => {
		render(RegistrationForm, { onsubmit: () => {} });
		await page.getByLabelText('Name').fill('Alice');
		await expect.element(page.getByRole('button', { name: 'Register' })).toBeDisabled();
	});

	it('submit button is disabled when only contact is filled', async () => {
		render(RegistrationForm, { onsubmit: () => {} });
		await page.getByLabelText('Contact').fill('alice@example.com');
		await expect.element(page.getByRole('button', { name: 'Register' })).toBeDisabled();
	});

	it('submit button is enabled when both fields are filled', async () => {
		render(RegistrationForm, { onsubmit: () => {} });
		await page.getByLabelText('Name').fill('Alice');
		await page.getByLabelText('Contact').fill('alice@example.com');
		await expect.element(page.getByRole('button', { name: 'Register' })).toBeEnabled();
	});

	it('submit button is disabled when disabled prop is true', async () => {
		render(RegistrationForm, { onsubmit: () => {}, disabled: true });
		await page.getByLabelText('Name').fill('Alice');
		await page.getByLabelText('Contact').fill('alice@example.com');
		await expect.element(page.getByRole('button')).toBeDisabled();
	});

	it('shows error message when error prop is set', async () => {
		render(RegistrationForm, { onsubmit: () => {}, error: 'Something went wrong' });
		await expect.element(page.getByRole('alert')).toHaveTextContent('Something went wrong');
	});

	it('does not show alert when error prop is empty', async () => {
		render(RegistrationForm, { onsubmit: () => {} });
		expect(page.getByRole('alert').elements()).toHaveLength(0);
	});

	it('calls onsubmit with trimmed name and contact', async () => {
		const submitted: { name: string; contact: string }[] = [];
		render(RegistrationForm, { onsubmit: (d) => submitted.push(d) });
		await page.getByLabelText('Name').fill('  Alice  ');
		await page.getByLabelText('Contact').fill('  alice@example.com  ');
		await page.getByRole('button', { name: 'Register' }).click();
		expect(submitted).toHaveLength(1);
		expect(submitted[0]).toEqual({ name: 'Alice', contact: 'alice@example.com' });
	});

	it('does not call onsubmit when form is empty and button is clicked', async () => {
		const onsubmit = vi.fn();
		render(RegistrationForm, { onsubmit });
		// button is disabled so click should have no effect
		const btn = page.getByRole('button', { name: 'Register' });
		await expect.element(btn).toBeDisabled();
		expect(onsubmit).not.toHaveBeenCalled();
	});

	it('submit button is disabled for whitespace-only name', async () => {
		render(RegistrationForm, { onsubmit: () => {} });
		await page.getByLabelText('Name').fill('   ');
		await page.getByLabelText('Contact').fill('alice@example.com');
		await expect.element(page.getByRole('button', { name: 'Register' })).toBeDisabled();
	});
});
