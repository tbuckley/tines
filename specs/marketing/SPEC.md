# Marketing landing page

The anonymous `/` route presents the approved “Office at the Center” story selected in Tines/295. The copy and local artwork are static, recorded examples—not live account data. Authenticated visitors continue to redirect server-side to `/issues`.

The page is server-rendered and remains readable without JavaScript or WebGL. A page-local, lazy-loaded three.js 0.160.0 controller owns one decorative canvas; bundled stills cover initialization, reduced capability, import failure, and context loss. The controller must remove listeners, cancel animation, dispose GPU resources, and remove its canvas on navigation. Marketing fonts, colors, and controls are scoped to the page and do not modify the saved application theme.

Both “Sign in” actions open the same native dialog and use the existing Better Auth Google and magic-link methods. Pending, success, retry, invalid-link recovery, and network failures stay in the dialog; stale completions after close or navigation are ignored. The invalid-link explanation is also present in server-rendered output.

The page follows the approved concept except for supervisor language superseded by `specs/supervisor/AUTOMATION_DEFAULT_2026-09-09.md`: automation starts enabled, routing chooses eligible work, and operators pause dispatch when needed. The historical Tines/13, PR #64, commit 48eb053, 796-test review, runners, transitions, and #75/#77 examples remain labelled records.

Release review covers 390×844, 1440×900, and 844×390; keyboard focus and 200% zoom; reduced motion and pause/resume; forced rendering failure; navigation cleanup; Safari/iPhone behavior; and low-end-phone performance. Physical-device checks are required release evidence when hardware is available.
