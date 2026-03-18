<script lang="ts">
	import QRCode from 'qrcode';

	let { value }: { value: string } = $props();

	let canvas: HTMLCanvasElement | undefined = $state();

	$effect(() => {
		if (canvas && value) {
			QRCode.toCanvas(canvas, value, { margin: 1 });
		}
	});
</script>

<canvas bind:this={canvas}></canvas>
