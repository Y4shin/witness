import prettier from 'eslint-config-prettier';
import path from 'node:path';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser,
				svelteConfig
			}
		}
	},

	// ── API contract enforcement ───────────────────────────────────────────────

	// Every json() call in a +server.ts route must annotate its return type with
	// `satisfies ResponseType` so the compiler enforces the server/client contract.
	// Bad:  return json({ nonce })
	// Good: return json({ nonce } satisfies ChallengeResponse)
	// Test-only seed routes are excluded — they are not part of the API contract.
	{
		files: ['src/routes/**/*+server.ts'],
		ignores: ['src/routes/api/_test/**'],
		rules: {
			'no-restricted-syntax': [
				'error',
				{
					selector:
						"CallExpression[callee.name='json'][arguments.0.type!='TSSatisfiesExpression']",
					message:
						"json() return values must use 'satisfies': return json({ ... } satisfies ResponseType). Add the type to src/lib/api-types.ts if missing."
				}
			]
		}
	},

	// svelte/no-navigation-without-resolve is intended for beforeNavigate/onNavigate
	// callbacks where resolve() must be called to allow navigation to proceed.
	// It incorrectly fires on goto() calls in onMount and event handlers, which
	// are fully valid usage. Disable globally since we never use beforeNavigate.
	{
		files: ['**/*.svelte'],
		rules: { 'svelte/no-navigation-without-resolve': 'off' }
	},

	// Raw fetch() is banned in page and component files.
	// Use the typed API client from $lib/client/api instead.
	// Bad:  const res = await fetch('/api/auth/challenge')
	// Good: const { nonce } = await api.auth.challenge()
	{
		files: ['src/routes/**/*.svelte', 'src/lib/components/**/*.svelte'],
		rules: {
			'no-restricted-syntax': [
				'error',
				{
					selector: "CallExpression[callee.name='fetch']",
					message:
						"Use the typed API client from $lib/client/api instead of raw fetch(). Add a new method to api.ts if the endpoint isn't covered yet."
				}
			]
		}
	}
);
