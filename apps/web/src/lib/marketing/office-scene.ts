// The geometry is intentionally kept close to the approved concept source.
// @ts-nocheck -- the generated geometry is a direct, isolated port; its public lifecycle is typed below.
import * as T from 'three';
import { stillMeta } from './still-meta';
import { officePhase, viewportCenter } from './office-layout';

export type OfficeMotionState = { paused: boolean; failed: boolean };
export type OfficeFrame = { phase: number; progress: number };
export type OfficeController = { toggleMotion(): void; destroy(): void };

export function createOfficeScene({
	rootEl,
	onFrame,
	onMotionChange
}: {
	rootEl: HTMLElement;
	onFrame: (frame: OfficeFrame) => void;
	onMotionChange: (state: OfficeMotionState) => void;
}): OfficeController {
	const $ = (s) => rootEl.querySelector(s),
		$$ = (s) => [...rootEl.querySelectorAll(s)];
	const seed = 'm3EdxN3xU2Kv3T',
		seedValues = [...seed].map((c) => c.charCodeAt(0)),
		seedGroups = [seed.slice(0, 4), seed.slice(4, 8), seed.slice(8)].map((s) =>
			[...s].reduce((a, c) => a + c.charCodeAt(0), 0)
		);
	let renderer,
		scene,
		camera,
		root,
		team,
		org,
		deskOne,
		route,
		token,
		endpoints,
		failed = false,
		traffic = [],
		elapsed = 0,
		lastTime = null,
		paused = false,
		dirty = 3,
		layout,
		progress = 0,
		phase = 0,
		disposed = false,
		frameId = 0;
	const reduced = matchMedia('(prefers-reduced-motion: reduce)');
	paused = reduced.matches;
	const onContextLost = (event) => {
		event.preventDefault();
		failed = true;
		cleanupRenderer();
		sync();
	};
	function build() {
		renderer = new T.WebGLRenderer({
			alpha: true,
			antialias: true,
			preserveDrawingBuffer: true
		});
		renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
		renderer.localClippingEnabled = true;
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = T.PCFSoftShadowMap;
		renderer.outputColorSpace = T.SRGBColorSpace;
		renderer.toneMapping = T.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.25;
		$('#stage').prepend(renderer.domElement);
		scene = new T.Scene();
		camera = new T.OrthographicCamera(-7, 7, 4, -4, 0.1, 100);
		root = new T.Group();
		scene.add(root);
		scene.add(new T.HemisphereLight(0xf4f8ff, 0x869099, 0.85));
		const sun = new T.DirectionalLight(0xfff2dd, 2.2);
		sun.position.set(-7, 13, 9);
		sun.castShadow = true;
		sun.shadow.mapSize.set(2048, 2048);
		Object.assign(sun.shadow.camera, {
			left: -13,
			right: 13,
			top: 12,
			bottom: -12,
			near: 1,
			far: 40
		});
		sun.shadow.bias = -0.0005;
		sun.shadow.normalBias = 0.035;
		scene.add(sun);
		const fill = new T.DirectionalLight(0xd8eaff, 0.6);
		fill.position.set(8, 5, -7);
		scene.add(fill);
		const mat = {
			board: new T.MeshStandardMaterial({ color: 0x91a9b4, roughness: 0.94 }),
			cut: new T.MeshStandardMaterial({ color: 0xbcd0d5, roughness: 1 }),
			wood: new T.MeshStandardMaterial({ color: 0xcbb995, roughness: 0.84 }),
			end: new T.MeshStandardMaterial({ color: 0xa98b63, roughness: 0.9 }),
			metal: new T.MeshStandardMaterial({
				color: 0x455d68,
				roughness: 0.58,
				metalness: 0.15
			}),
			paper: new T.MeshStandardMaterial({ color: 0xf3f2e6, roughness: 1 }),
			blue: new T.MeshStandardMaterial({ color: 0x356a8d, roughness: 0.8 }),
			felt: new T.MeshStandardMaterial({ color: 0x698392, roughness: 1 }),
			screen: new T.MeshStandardMaterial({ color: 0x244250, roughness: 0.6 }),
			green: new T.MeshStandardMaterial({ color: 0x698078, roughness: 0.9 }),
			clay: new T.MeshStandardMaterial({ color: 0xa1a9a0, roughness: 1 })
		};
		mat.board.color.lerp(new T.Color(0xa6bbc2), (seedGroups[1] % 13) / 40);
		mat.wood.color.lerp(new T.Color(0xbba381), (seedGroups[2] % 9) / 30);
		function box(w, h, d, x, y, z, m, parent = root) {
			const o = new T.Mesh(new T.BoxGeometry(w, h, d), mat[m]);
			o.position.set(x, y, z);
			o.castShadow = true;
			o.receiveShadow = true;
			parent.add(o);
			return o;
		}
		function cyl(r1, r2, h, x, y, z, m, parent = root) {
			const o = new T.Mesh(new T.CylinderGeometry(r1, r2, h, 24), mat[m]);
			o.position.set(x, y, z);
			o.castShadow = true;
			o.receiveShadow = true;
			parent.add(o);
			return o;
		}
		function ball(r, x, y, z, m, parent) {
			const o = new T.Mesh(new T.SphereGeometry(r, 20, 14), mat[m]);
			o.position.set(x, y, z);
			o.castShadow = true;
			parent.add(o);
			return o;
		}
		function bar(a, b, r, m, parent) {
			let av = new T.Vector3(...a),
				bv = new T.Vector3(...b);
			const o = cyl(r, r, av.distanceTo(bv), 0, 0, 0, m, parent);
			o.position.copy(av).add(bv).multiplyScalar(0.5);
			o.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), bv.sub(av).normalize());
			return o;
		}
		function plant(x, y, z, parent) {
			cyl(0.16, 0.12, 0.25, x, y + 0.12, z, 'clay', parent);
			for (let i = 0; i < 5; i++) {
				const a = i * 2.4;
				bar(
					[x, y + 0.2, z],
					[x + Math.sin(a) * 0.15, y + 0.5 + i * 0.035, z + Math.cos(a) * 0.12],
					0.013,
					'green',
					parent
				);
				const leaf = ball(
					0.11,
					x + Math.sin(a) * 0.15,
					y + 0.5 + i * 0.035,
					z + Math.cos(a) * 0.12,
					'green',
					parent
				);
				leaf.scale.set(0.45, 1.5, 0.85);
			}
		}
		function desk(x, y, z, parent, operator = true) {
			const d = new T.Group();
			d.position.set(x, y, z);
			parent.add(d);
			box(2.1, 0.11, 1.05, 0, 1.04, 0, 'wood', d);
			box(2.1, 0.035, 1.05, 0, 0.97, 0, 'end', d);
			[-0.88, 0.88].forEach((a) =>
				[-0.4, 0.4].forEach((b) => box(0.05, 0.98, 0.05, a, 0.48, b, 'metal', d))
			);
			box(1.76, 0.05, 0.04, 0, 0.25, -0.4, 'metal', d);
			for (let k = 0; k < 10; k++) box(1.91, 0.002, 0.006, 0, 1.097, -0.43 + k * 0.09, 'end', d);
			box(0.61, 0.39, 0.045, 0.24, 1.36, -0.28, 'metal', d);
			box(0.54, 0.32, 0.007, 0.24, 1.36, -0.25, 'screen', d);
			box(0.025, 0.17, 0.025, 0.24, 1.16, -0.28, 'metal', d);
			box(0.32, 0.022, 0.2, 0.24, 1.107, -0.25, 'metal', d);
			box(0.52, 0.035, 0.19, 0.24, 1.12, 0.11, 'paper', d);
			for (let k = 0; k < 4; k++) box(0.4, 0.005, 0.012, 0.24, 1.14, 0.05 + k * 0.035, 'felt', d);
			box(0.35, 0.04, 0.28, -0.57, 1.12, 0.05, 'paper', d);
			box(0.3, 0.015, 0.23, -0.6, 1.15, 0.07, 'paper', d);
			cyl(0.065, 0.065, 0.12, 0.76, 1.16, 0.25, 'paper', d);
			cyl(0.046, 0.046, 0.006, 0.76, 1.224, 0.25, 'screen', d);
			cyl(0.15, 0.15, 0.025, -0.76, 1.115, -0.28, 'metal', d);
			bar([-0.76, 1.13, -0.28], [-0.76, 1.65, -0.28], 0.024, 'metal', d);
			bar([-0.76, 1.65, -0.28], [-0.52, 1.65, -0.2], 0.021, 'metal', d);
			cyl(0.04, 0.12, 0.13, -0.5, 1.6, -0.2, 'paper', d);
			box(0.63, 0.1, 0.58, 0, 0.54, 0.94, 'felt', d);
			box(0.64, 0.51, 0.07, 0, 0.83, 1.19, 'felt', d);
			bar([0, 0.52, 0.94], [0, 0.15, 0.94], 0.035, 'metal', d);
			for (let k = 0; k < 5; k++) {
				const a = (k * 6.28) / 5;
				bar(
					[0, 0.15, 0.94],
					[Math.sin(a) * 0.36, 0.09, 0.94 + Math.cos(a) * 0.36],
					0.022,
					'metal',
					d
				);
				ball(0.055, Math.sin(a) * 0.36, 0.07, 0.94 + Math.cos(a) * 0.36, 'metal', d);
			}
			if (operator) {
				cyl(0.16, 0.21, 0.44, 0, 0.94, 0.92, 'felt', d);
				ball(0.16, 0, 1.33, 0.9, 'wood', d);
				[-1, 1].forEach((s) => {
					bar([s * 0.15, 1.1, 0.91], [s * 0.25, 1.08, 0.35], 0.06, 'felt', d);
					bar([s * 0.12, 0.67, 0.88], [s * 0.15, 0.2, 0.65], 0.065, 'metal', d);
				});
			}
			return d;
		}
		deskOne = new T.Group();
		root.add(deskOne);
		desk(0, 0, 0, deskOne);
		box(3.1, 0.18, 2.65, 0, -0.12, 0.28, 'cut', deskOne);
		plant(1.2, 0, -0.7, deskOne);
		team = new T.Group();
		root.add(team);
		box(9.8, 0.22, 5.5, 0, -0.24, 0, 'board', team);
		box(9.8, 0.025, 5.5, 0, -0.115, 0, 'cut', team);
		[-3.25, 3.25].forEach((x) => desk(x, 0, 0, team));
		[-1.58, 1.58].forEach((x) => {
			box(0.1, 1.48, 2.4, x, 0.64, -0.45, 'board', team);
			box(0.14, 0.045, 2.4, x, 1.39, -0.45, 'wood', team);
		});
		[-3.25, 0, 3.25].forEach((x) => {
			box(2.95, 1.48, 0.1, x, 0.64, -1.55, 'board', team);
			for (let j = 0; j < 3; j++)
				box(0.29, 0.22, 0.01, x - 0.6 + j * 0.4, 1.06, -1.489, j === 1 ? 'paper' : 'cut', team);
		});
		box(1.1, 0.85, 0.7, -3.65, 0.32, -2.1, 'wood', team);
		[0.05, 0.32, 0.59].forEach((y) => {
			box(0.99, 0.018, 0.02, -3.65, y, -1.74, 'end', team);
			box(0.2, 0.025, 0.02, -3.65, y + 0.1, -1.735, 'metal', team);
		});
		plant(4, 0, -2.05, team);

		// Routed brass-free mineral inlay. The issue uses this same polyline.
		route = new T.Group();
		team.add(route);
		const routePoints = [
			[-3.25, 1.15, 0.4],
			[0, 1.15, 0.4],
			[0, 1.15, 1.85],
			[3.25, 1.15, 1.85],
			[3.25, 1.15, 0.4]
		];
		routePoints.slice(1).forEach((b, i) => bar(routePoints[i], b, 0.027, 'blue', route));
		bar([3.25, 1.15, 2.15], [0, 1.15, 2.15], 0.03, 'metal', route);
		bar([3.25, 1.15, 0.4], [3.25, 1.15, 2.15], 0.03, 'metal', route);
		bar([0, 1.15, 2.15], [0, 1.15, 0.4], 0.03, 'metal', route);
		[-2.3, 1.75].forEach((x) => {
			const arrow = new T.Mesh(new T.ConeGeometry(0.085, 0.21, 12), mat.blue);
			arrow.rotation.z = -Math.PI / 2;
			arrow.position.set(x, 1.15, 1.85);
			route.add(arrow);
		});
		org = new T.Group();
		root.add(org);
		const courtX = 0.45 + (seedGroups[0] % 5) * 0.16;
		// Open, offset courtyard; boards are cut around a real void rather than covered by a painted patch.
		const floorY = 2.85;
		box(9.8, 0.2, 1.45, 0, floorY, -1.95, 'board', org);
		box(9.8, 0.2, 1.5, 0, floorY, 2.03, 'board', org);
		const voidHalf = 1.9 + (seedValues[1] % 3) * 0.1,
			leftEdge = courtX - voidHalf,
			rightEdge = courtX + voidHalf;
		box(leftEdge + 4.9, 0.2, 2.5, (leftEdge - 4.9) / 2, floorY, 0.02, 'board', org);
		box(4.9 - rightEdge, 0.2, 2.5, (rightEdge + 4.9) / 2, floorY, 0.02, 'board', org);
		[-4.75, 4.75].forEach((x) =>
			[-2.6, 2.6].forEach((z) => box(0.13, 3, 0.13, x, 1.25, z, 'wood', org))
		);
		desk(-3.2, 3, 0, org);
		desk(3.65, 3, 0, org);
		box(9.8, 2.05, 0.14, 0, 3.92, -2.65, 'board', org);
		box(0.15, 2.05, 5.3, -4.85, 3.92, 0, 'board', org);
		// Clerestory reveals, shelving, stairs and cut end-grain edges.
		[-3.7, -2.45, -1.2, 0.05, 1.3, 2.55, 3.8].forEach((x) => {
			box(0.97, 0.95, 0.045, x, 4.18, -2.55, 'cut', org);
			box(0.035, 0.95, 0.065, x, 4.18, -2.51, 'wood', org);
		});
		for (let i = 0; i < 12; i++) box(0.83, 0.12, 0.29, 1.9, i * 0.247, 2.7 - i * 0.26, 'wood', org);
		bar([2.4, 0.75, 2.9], [2.4, 3.7, -0.3], 0.027, 'metal', org);
		[0, 3, 6, 9].forEach((i) =>
			bar(
				[2.4, i * 0.247, 2.7 - i * 0.26],
				[2.4, i * 0.247 + 0.8, 2.7 - i * 0.26],
				0.02,
				'metal',
				org
			)
		);
		box(0.13, 0.85, 3.3, leftEdge, 3.45, 0.2, 'wood', org);
		box(0.13, 0.85, 3.3, rightEdge, 3.45, 0.2, 'wood', org);
		for (let j = 0; j < 3; j++) {
			box(1.55, 0.055, 0.4, -3.45, 3.4 + j * 0.47, -2.26, 'wood', org);
			for (let k = 0; k < 7; k++)
				box(
					0.09,
					0.28 + (k % 3) * 0.03,
					0.25,
					-4.02 + k * 0.18,
					3.57 + j * 0.47,
					-2.26,
					k % 2 ? 'paper' : 'felt',
					org
				);
		}
		plant(-4, 3, 1.6, org);
		plant(courtX, -0.1, -0.85, team);
		plant(courtX + 0.4, -0.1, -1.1, team);
		// Distinct proposal slips stay at their destination desks.
		box(0.45, 0.06, 0.32, -3.5, 4.15, 0.15, 'paper', org);
		box(0.32, 0.006, 0.025, -3.5, 4.183, 0.15, 'blue', org);
		box(0.45, 0.06, 0.32, 3.4, 4.15, 0.15, 'paper', org);
		box(0.32, 0.006, 0.025, 3.4, 4.183, 0.15, 'blue', org);
		bar([0, 1.2, 2.4], [0, 3.12, 2.4], 0.028, 'blue', org);
		bar([0, 3.12, 2.4], [-3.5, 3.12, 2.4], 0.028, 'blue', org);
		bar([0, 3.12, 2.4], [3.4, 3.12, 2.4], 0.028, 'blue', org);
		token = new T.Group();
		root.add(token);
		box(0.43, 0.08, 0.32, 0, 0, 0, 'blue', token);
		box(0.26, 0.005, 0.025, 0, 0.043, -0.04, 'paper', token);
		box(0.2, 0.005, 0.025, -0.03, 0.043, 0.05, 'paper', token);

		endpoints = new T.Group();
		root.add(endpoints);
		box(0.86, 1, 0.7, -6, 0.48, 1.8, 'blue', endpoints);
		box(1, 0.14, 0.84, -6, 1.03, 1.8, 'cut', endpoints);
		box(0.63, 0.11, 0.015, -6, 0.79, 2.158, 'screen', endpoints);
		box(0.38, 0.23, 0.02, -6, 0.41, 2.162, 'paper', endpoints);
		box(1.25, 0.15, 1.15, -6, -0.09, 1.8, 'cut', endpoints);
		box(1.3, 0.14, 1.1, 6, -0.09, 1.8, 'cut', endpoints);
		box(0.09, 1.45, 0.09, 6, 0.7, 1.8, 'wood', endpoints);
		box(0.9, 0.48, 0.09, 6, 1.42, 1.8, 'blue', endpoints);
		function slip(color, plane = false) {
			const g = new T.Group();
			endpoints.add(g);
			if (plane) {
				let geom = new T.BufferGeometry();
				geom.setAttribute(
					'position',
					new T.Float32BufferAttribute(
						[
							-0.38, 0, 0.3, 0.48, 0, 0, -0.38, 0, -0.3, -0.38, 0, 0.3, -0.18, 0.15, 0, 0.48, 0, 0,
							-0.38, 0, -0.3, 0.48, 0, 0, -0.18, 0.15, 0
						],
						3
					)
				);
				geom.computeVertexNormals();
				const mesh = new T.Mesh(
					geom,
					new T.MeshStandardMaterial({ color, roughness: 1, side: T.DoubleSide })
				);
				mesh.castShadow = true;
				g.add(mesh);
			} else {
				const m = box(0.32, 0.07, 0.25, 0, 0, 0, 'paper', g);
				m.material = m.material.clone();
				m.material.color.set(color);
				box(0.21, 0.01, 0.025, 0, 0.044, 0, 'metal', g);
			}
			return g;
		}
		const paths = [
			[
				[-40, 1.3, 1.8],
				[-6, 1.17, 1.8],
				[-6, 1.17, 1.8],
				[-3.25, 1.2, 1.85],
				[-3.25, 1.2, 0.4],
				[0, 1.2, 0.4]
			],
			[
				[-40, 1.55, 2.25],
				[-6, 1.17, 1.8],
				[-6, 1.17, 1.8],
				[-3.25, 1.2, 2.15],
				[3.25, 1.2, 2.15],
				[3.25, 1.2, 0.4]
			],
			[
				[-3.5, 4.18, 0.15],
				[-3.5, 4.18, 1.9],
				[0.5, 4.18, 2.6],
				[3.5, 4.18, 1.9],
				[3.5, 4.18, 0.15]
			],
			[
				[3.25, 1.4, 0.4],
				[3.25, 1.8, 2.3],
				[6, 2.0, 1.8],
				[40, 2.3, 1.8]
			],
			[
				[-3.5, 4.3, 0.15],
				[-1, 4.6, 2.4],
				[4.8, 4.6, 2.4],
				[40, 4.4, 1.8]
			],
			[
				[3.5, 4.3, 0.15],
				[4.9, 4.4, 0.7],
				[6, 4.4, 1.8],
				[40, 4.2, 1.8]
			]
		];
		paths.forEach((points, i) => {
			traffic.push({
				mesh: slip([0xe4cc96, 0x789caf, 0xf0eee2, 0xedeee4, 0x688fa5, 0xc59d56][i], i > 2),
				points: points.map((p) => new T.Vector3(...p)),
				offset: i * 0.167,
				kind: i > 2 ? 'artifact delivery' : i < 2 ? 'mailbox intake' : 'agent handoff'
			});
		});
		// Fine floor routes join the mailbox and delivery side. No lights or particles.
		bar([-6, 0.03, 1.8], [-4.7, 0.03, 1.8], 0.025, 'blue', endpoints);
		bar([4.7, 0.03, 1.8], [6, 0.03, 1.8], 0.025, 'blue', endpoints);
		const ground = new T.Mesh(new T.PlaneGeometry(70, 70), new T.ShadowMaterial({ opacity: 0.16 }));
		ground.rotation.x = -Math.PI / 2;
		ground.position.y = -0.37;
		ground.receiveShadow = true;
		scene.add(ground);
		renderer.domElement.addEventListener('webglcontextlost', onContextLost);
	}
	const clamp = (n, a = 0, b = 1) => Math.min(b, Math.max(a, n)),
		smooth = (n) => {
			n = clamp(n);
			return n * n * (3 - 2 * n);
		};
	function measure() {
		const center = viewportCenter(innerWidth, innerHeight, layout);
		const apertures = $$('.aperture').map((e) => {
			const r = e.getBoundingClientRect();
			return {
				top: r.top + scrollY,
				height: r.height,
				left: r.left,
				width: r.width,
				center: r.top + scrollY + r.height / 2
			};
		});
		layout = {
			width: innerWidth,
			height: innerHeight,
			center,
			apertures,
			landings: apertures.map((a) => a.center - center),
			end: document.documentElement.scrollHeight - innerHeight
		};
		if (renderer) renderer.setSize(innerWidth, innerHeight, false);
	}
	function state() {
		const calculated = officePhase({
			width: layout.width,
			height: layout.height,
			scrollY,
			end: layout.end,
			apertures: layout.apertures
		});
		progress = calculated.progress;
		phase = calculated.phase;
		const { failedAt, returnAt, humanAt } = calculated;
		layout.review = { failedAt, returnAt, humanAt };
		return { p: progress, phase };
	}
	function pointOn(points, f) {
		const lengths = points.slice(1).map((p, i) => p.distanceTo(points[i]));
		let d = clamp(f) * lengths.reduce((a, b) => a + b, 0);
		for (let i = 0; i < lengths.length; i++) {
			if (d <= lengths[i] || i === lengths.length - 1)
				return points[i].clone().lerp(points[i + 1], lengths[i] ? clamp(d / lengths[i]) : 0);
			d -= lengths[i];
		}
	}
	function config() {
		let { p } = state();
		const { width: w, height: h, center } = layout;
		const entry = smooth(scrollY / Math.max(100, layout.landings[0]));
		const aps = layout.apertures;
		const noteH = 135;
		let stageW = Math.min(w - 28, 930);
		const frame = (i, y) => {
			const a = aps[i],
				top = Math.max(0, a.top - y),
				bottom = Math.min(h, a.top + a.height - y),
				room = Math.max(0, bottom - top);
			const stageH = Math.min(
				w < 650 ? 250 : 310,
				Math.max(40, room - noteH * smooth((room - 220) / 120) - 28)
			);
			const cy = top + Math.min(room / 2, stageH / 2 + 14);
			return { room, stageH, cy, top, bottom };
		};
		// Fit the model to actual exposed space, not an interpolated point behind a record.
		// The document owns framing; scroll stops have no trailing camera clock.
		const frames = aps.map((_, i) => frame(i, scrollY));
		let index = frames.reduce((best, f, i) => (f.room > frames[best].room ? i : best), 0);
		let f = frames[index];
		const ordered = frames
			.map((f, i) => ({ ...f, i }))
			.filter((f) => f.room > 0)
			.sort((a, b) => a.i - b.i);
		if (ordered.length === 2) {
			const [a, b] = ordered,
				d = b.room - a.room;
			if (Math.abs(d) < 30) {
				const t = smooth((d + 30) / 60);
				f = {
					room: Math.max(a.room, b.room),
					stageH: a.stageH + (b.stageH - a.stageH) * t,
					cy: a.cy + (b.cy - a.cy) * t
				};
			}
		}
		stageW = Math.min(aps[index].width - 28, 930);
		const { stageH, room } = f;
		const fitH = 4.4 + 2.2 * smooth(p) + 5.2 * smooth(p - 1),
			fitW = 5.6 + 9 * smooth(p) + 3.2 * smooth(p - 1);
		const scale = 1 / ((1 - entry) * 3.5 + entry);
		const fullH = (Math.max(fitH / stageH, fitW / stageW) * h) / scale;
		// One reversible geometric mapping; opaque records frame the crossing.
		const x =
			(w < 650 ? w * 0.8 : w * 0.79) * (1 - entry) +
			(aps[index].left + aps[index].width / 2) * entry;
		const y = (w < 650 ? 285 : 230) * (1 - entry) + f.cy * entry;
		const note = $('#scene-note');
		note.style.left = x + 'px';
		note.style.width = Math.min(600, aps[index].width - 44) + 'px';
		note.style.top = y + stageH / 2 + 8 + 'px';
		note.hidden = entry < 0.85 || room < 340;
		return { p, fullH, x, y, entry, stageH, stageW, index, room, noteH };
	}
	function render() {
		const c = config(),
			p = c.p,
			upper = clamp(p - 1),
			grow = clamp(p),
			{ width: w, height: h } = layout;
		const label = $('#token-label');
		label.hidden = true;
		if (!renderer || failed) {
			updateStill(c);
			return;
		}
		team.visible = grow > 0.001;
		team.scale.setScalar(Math.max(0.001, grow));
		org.visible = upper > 0.001;
		org.scale.setScalar(Math.max(0.001, upper));
		org.position.y = 0;
		endpoints.visible = upper > 0.85;
		const halfH = c.fullH / 2,
			halfW = (halfH * w) / h,
			cx = (0.5 - c.x / w) * halfW * 2,
			cy = (c.y / h - 0.5) * halfH * 2;
		Object.assign(camera, {
			left: -halfW + cx,
			right: halfW + cx,
			top: halfH + cy,
			bottom: -halfH + cy
		});
		camera.position.set(9, 10, 14);
		camera.lookAt(0, 0.6 + upper * 1.65, 0);
		camera.updateProjectionMatrix();
		const coords = [
			[0, 1.22, 0.3],
			[3.25, 1.22, 0.4],
			[0, 1.22, 0.4],
			[3.25, 1.22, 1.85],
			[0, 1.22, 2.15]
		];
		let pos = coords[phase];
		if (p < 0.8) pos = [-0.56, 1.22, 0.1];
		if (phase === 2) {
			const f = smooth((scrollY - layout.review.returnAt) / 80);
			pos = pointOn(
				[
					[3.25, 1.22, 0.4],
					[3.25, 1.22, 2.15],
					[0, 1.22, 2.15],
					[0, 1.22, 0.4]
				].map((a) => new T.Vector3(...a)),
				f
			).toArray();
		}
		token.position.set(...pos);
		traffic.forEach((t, i) => {
			const f = (elapsed / (i > 2 ? 8 : 11) + t.offset) % 1;
			const travel = (q) => {
				if (i < 2)
					return q < 0.12
						? t.points[0].clone().lerp(t.points[1], q / 0.12)
						: q < 0.25
							? t.points[1].clone()
							: pointOn(t.points.slice(2), (q - 0.25) / 0.63);
				if (i > 2) {
					const j = q < 0.4 ? 0 : q < 0.8 ? 1 : 2,
						fraction = j < 2 ? (q - j * 0.4) / 0.4 : (q - 0.8) / 0.2;
					return t.points[j].clone().lerp(t.points[j + 1], clamp(fraction));
				}
				return pointOn(t.points, q);
			};
			t.mesh.position.copy(travel(f));
			if (i > 2) {
				const ahead = travel(Math.min(1, f + 0.01));
				t.mesh.rotation.y = -Math.atan2(ahead.z - t.mesh.position.z, ahead.x - t.mesh.position.x);
			}
			t.mesh.visible = upper > 0.97 && f < 0.93;
			if (f >= 0.93) t.mesh.position.set(-40, -20, 0);
			t.mesh.scale.setScalar(i > 2 ? 1.9 : 1.5);
		});
		renderer.render(scene, camera);
		function place(id, xyz) {
			const v = new T.Vector3(...xyz).project(camera),
				el = $(id);
			el.style.left = (v.x * 0.5 + 0.5) * w + 'px';
			el.style.top = (-v.y * 0.5 + 0.5) * h + 'px';
		}
		place('#token-label', [pos[0], pos[1] + 0.2, pos[2]]);
		place('#intake-label', [-6, 1.35, 1.8]);
		place('#output-label', [6, 2.05, 1.8]);
		$('#intake-label').hidden = $('#output-label').hidden = true;
		$('#still').hidden = true;
		renderer.domElement.hidden = false;
		onFrame({ phase, progress });
	}
	function updateStill(c) {
		const scope = phase === 0 ? 'task' : phase === 4 ? 'office' : 'team',
			key = (layout.width < 650 ? 'phone' : 'desktop') + '-' + scope + '-' + phase;
		const img = $('#still'),
			meta = stillMeta[key];
		img.src = '/marketing/office-v1/' + key + '.png';
		img.hidden = false;
		if (renderer) renderer.domElement.hidden = true;
		const bw = layout.width < 650 ? 390 : 1440,
			bh = layout.width < 650 ? 844 : 900,
			bc = bh * 0.45;
		const sp = scope === 'task' ? 0 : scope === 'team' ? 1 : 2;
		const sourceH =
			Math.max(
				(4.4 + 2.2 * smooth(sp) + 5.2 * smooth(sp - 1)) / (bw < 650 ? 300 : 360),
				(5.6 + 9 * smooth(sp) + 3.2 * smooth(sp - 1)) / Math.min(bw - 28, 930)
			) * bh;
		const k = ((sourceH / c.fullH) * layout.height) / bh;
		Object.assign(img.style, {
			width: bw * k + 'px',
			height: bh * k + 'px',
			left: c.x - (bw * k) / 2 + 'px',
			top: c.y - bc * k + 'px',
			objectFit: 'fill',
			transform: 'none'
		});
		$('#token-label').hidden = true;
		$('#intake-label').hidden = $('#output-label').hidden = true;
		if (meta)
			['intake', 'output'].forEach((key) => {
				const el = $('#' + key + '-label');
				el.style.left = c.x + (meta[key][0] * bw - bw / 2) * k + 'px';
				el.style.top = c.y + (meta[key][1] * bh - bc) * k + 'px';
			});
		onFrame({ phase, progress });
	}
	function sync() {
		dirty = 3;
		onMotionChange({ paused, failed });
	}
	function tick(now) {
		if (disposed) return;
		const delta = lastTime === null ? 0 : clamp((now - lastTime) / 1000, 0, 0.08);
		lastTime = now;
		const a = layout.apertures[2],
			visible = a.top + a.height > scrollY && a.top < scrollY + layout.height;
		const run = !paused && !failed && !document.hidden && visible && progress > 1.97;
		if (run) elapsed += delta;
		if (dirty || run) {
			render();
			dirty = Math.max(0, dirty - 1);
		}
		frameId = requestAnimationFrame(tick);
	}
	function cleanupRenderer() {
		if (scene) {
			const geometries = new Set();
			const materials = new Set();
			scene.traverse((object) => {
				if (object.geometry) geometries.add(object.geometry);
				const values = Array.isArray(object.material) ? object.material : [object.material];
				values.filter(Boolean).forEach((material) => materials.add(material));
			});
			geometries.forEach((geometry) => geometry.dispose());
			materials.forEach((material) => material.dispose());
			scene = null;
		}
		if (renderer) {
			renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
			renderer.dispose();
			renderer.forceContextLoss();
			renderer.domElement.remove();
			renderer = null;
		}
	}
	try {
		build();
	} catch (e) {
		failed = true;
		cleanupRenderer();
	}
	measure();
	sync();
	frameId = requestAnimationFrame(tick);
	const onScroll = () => {
		dirty = 3;
	};
	const onResize = () => {
		measure();
		sync();
	};
	const onReduced = (event) => {
		paused = event.matches;
		lastTime = null;
		sync();
	};
	const onVisibility = () => {
		lastTime = null;
		sync();
	};
	window.addEventListener('scroll', onScroll, { passive: true });
	window.addEventListener('resize', onResize);
	document.fonts.ready.then(() => {
		if (disposed) return;
		measure();
		sync();
	});
	reduced.addEventListener('change', onReduced);
	document.addEventListener('visibilitychange', onVisibility);

	return {
		toggleMotion() {
			if (failed) return;
			paused = !paused;
			lastTime = null;
			sync();
		},
		destroy() {
			if (disposed) return;
			disposed = true;
			cancelAnimationFrame(frameId);
			window.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', onResize);
			reduced.removeEventListener('change', onReduced);
			document.removeEventListener('visibilitychange', onVisibility);
			cleanupRenderer();
		}
	};
}
