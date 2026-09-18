export type FocusNotice =
	| { kind: 'unknown'; ref: string }
	| { kind: 'archived'; ref: string; project: { id: string; name: string } };
