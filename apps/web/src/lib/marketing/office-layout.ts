export type Aperture = { top: number; height: number; left: number; width: number; center: number };
export type OfficeMeasurements = {
	width: number;
	height: number;
	scrollY: number;
	end: number;
	apertures: [Aperture, Aperture, Aperture];
};

export function viewportCenter(
	width: number,
	height: number,
	previous?: { width: number; center: number }
) {
	if (previous?.width === width) return previous.center;
	return height < 650 ? height * 0.43 : height * 0.45;
}

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const smooth = (value: number) => {
	const n = clamp(value);
	return n * n * (3 - 2 * n);
};

export function officePhase(measurements: OfficeMeasurements) {
	const { height, scrollY, end, apertures } = measurements;
	const teamStart = apertures[1].top - Math.min(height - 300, 400);
	const officeStart = apertures[2].top - Math.min(height - 260, 400);
	const progress =
		smooth((scrollY - teamStart) / 180) +
		smooth((scrollY - officeStart) / Math.max(60, Math.min(200, end - 40 - officeStart)));
	const failedAt = teamStart + 180;
	const returnAt = failedAt + 134;
	const humanAt = returnAt + 150;
	const phase =
		progress < 0.98 ? 0 : progress > 1.01 ? 4 : scrollY < returnAt ? 1 : scrollY < humanAt ? 2 : 3;
	return { progress, phase, failedAt, returnAt, humanAt };
}
