/**
 * The scope-chip classes, shared by `ContextScopeChips` and
 * `InheritedFromChip` so the width cap and the truncate-on-child rule from
 * Tines/221 stay single-sourced.
 *
 * The chip is the flex box and owns the width cap; the text inside it is a
 * separate block child wearing `truncate`. `text-overflow` only applies to a
 * block container's own inline text, so a `truncate` on the `inline-flex` chip
 * itself clipped mid-glyph with no ellipsis — it kept the `overflow: hidden`
 * half and silently dropped the ellipsis half.
 *
 * The cap is responsive because a chip does not always share its row with
 * something that can wrap: `ContextItemList` puts the item's own name and the
 * chips on one non-wrapping flex row, and the chips wrapper never shrinks
 * below this cap, so every pixel of it comes out of the name. At 224px the
 * name was down to a glyph or two on a phone, so narrow viewports keep the old
 * 192px and only `sm` and up get the wider cap.
 */
export const chipClass =
	'bg-muted text-muted-foreground inline-flex max-w-48 items-center gap-1 overflow-hidden rounded-full px-2 py-0.5 text-xs sm:max-w-56';

/**
 * The truncating text child. `overflow-hidden` on the chip and `shrink-0` on
 * the icons are belt-and-braces today — the chip never shrinks below its cap,
 * so this child's own `overflow: hidden` does all the clipping — and become
 * load-bearing only if the chip is ever made shrinkable.
 */
export const textClass = 'truncate';
