/**
 * Promise-based replacements for the native `confirm()`/`alert()` dialogs,
 * rendered as shadcn AlertDialogs by `<DialogHost>` (mounted once in the
 * root layout). Requests queue up, so a confirm can follow another dialog
 * (e.g. the force-cascade flows) without racing the close animation.
 */

export type ConfirmOptions = {
	title: string;
	/** Supporting copy under the title. */
	body?: string;
	/** Bulleted listing between the body and the buttons (e.g. cascade sweeps). */
	items?: string[];
	/** Defaults to 'Confirm'. */
	confirmLabel?: string;
	/** Defaults to 'Cancel'. */
	cancelLabel?: string;
	/** Style the confirm button for a destructive action. */
	destructive?: boolean;
};

export type AlertOptions = Pick<ConfirmOptions, 'title' | 'body'>;

export type DialogRequest = ConfirmOptions & {
	kind: 'confirm' | 'alert';
	resolve: (confirmed: boolean) => void;
};

export const pendingDialogs = $state<{ queue: DialogRequest[] }>({ queue: [] });

/** Drop-in `confirm()` replacement: resolves true only on the confirm button. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		pendingDialogs.queue.push({ kind: 'confirm', ...options, resolve });
	});
}

/** Drop-in `alert()` replacement: resolves once dismissed. */
export function alertDialog(options: AlertOptions): Promise<void> {
	return new Promise((resolve) => {
		pendingDialogs.queue.push({ kind: 'alert', ...options, resolve: () => resolve() });
	});
}
