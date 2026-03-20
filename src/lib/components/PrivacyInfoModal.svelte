<script lang="ts">
	import * as m from '$lib/paraglide/messages';

	interface Props {
		open: boolean;
		onclose: () => void;
		/** When true, shows "Understood, continue" instead of "Close" */
		continueMode?: boolean;
	}

	let { open, onclose, continueMode = false }: Props = $props();
</script>

{#if open}
	<div class="modal modal-open" role="dialog" aria-modal="true" aria-labelledby="privacy-modal-title">
		<div class="modal-box max-w-lg">
			<h2 id="privacy-modal-title" class="font-bold text-xl mb-5">{m.privacy_title()}</h2>

			<div class="flex flex-col gap-4 text-sm">
				<div>
					<p class="font-semibold mb-1">{m.privacy_e2e_heading()}</p>
					<p class="text-base-content/70">{m.privacy_e2e_body()}</p>
				</div>

				<div>
					<p class="font-semibold mb-1">{m.privacy_identity_heading()}</p>
					<p class="text-base-content/70">{m.privacy_identity_body()}</p>
				</div>

				<div>
					<p class="font-semibold mb-1">{m.privacy_key_heading()}</p>
					<p class="text-base-content/70">{m.privacy_key_body()}</p>
				</div>

				<div>
					<p class="font-semibold mb-1">{m.privacy_moderators_heading()}</p>
					<p class="text-base-content/70">{m.privacy_moderators_body()}</p>
				</div>

				<div>
					<p class="font-semibold mb-1">{m.privacy_backup_heading()}</p>
					<p class="text-base-content/70">{m.privacy_backup_body()}</p>
				</div>
			</div>

			<div class="modal-action">
				<button class="btn {continueMode ? 'btn-primary' : 'btn-ghost'}" onclick={onclose}>
					{continueMode ? m.privacy_continue() : m.privacy_close()}
				</button>
			</div>
		</div>
		<div class="modal-backdrop" role="none" onclick={onclose}></div>
	</div>
{/if}
