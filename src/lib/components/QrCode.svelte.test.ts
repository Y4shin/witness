import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import QrCode from './QrCode.svelte';

function getCanvas(): HTMLCanvasElement {
	const el = document.querySelector('canvas');
	if (!el) throw new Error('No <canvas> found in document');
	return el as HTMLCanvasElement;
}

describe('QrCode', () => {
	// ── happy path ──────────────────────────────────────────────────────────

	it('renders a canvas element for a non-empty value', async () => {
		render(QrCode, { value: 'https://example.com' });
		expect(document.querySelector('canvas')).not.toBeNull();
	});

	it('draws a square QR code on the canvas for a non-empty value', async () => {
		render(QrCode, { value: 'https://example.com' });
		const canvas = getCanvas();

		// QRCode.toCanvas is async; poll until the canvas is square (all QR codes
		// are square), confirming the draw completed.
		await expect
			.poll(
				() => {
					const w = canvas.width;
					const h = canvas.height;
					return w > 0 && w === h;
				},
				{ timeout: 5000 }
			)
			.toBe(true);
	});

	// ── non-happy path ───────────────────────────────────────────────────────

	it('renders a canvas without drawing when value is an empty string', async () => {
		render(QrCode, { value: '' });
		// Canvas element must be present
		const canvas = getCanvas();
		expect(canvas).not.toBeNull();
		// Nothing should be drawn: canvas stays at default 300×150 (not square)
		expect(canvas.width).not.toEqual(canvas.height);
	});

	it('renders without crashing for a very long value (2 000-char URL)', async () => {
		const longValue = 'https://example.com/' + 'a'.repeat(2000);
		render(QrCode, { value: longValue });
		// Canvas must be present regardless of whether the library can encode it
		expect(document.querySelector('canvas')).not.toBeNull();
	});
});
