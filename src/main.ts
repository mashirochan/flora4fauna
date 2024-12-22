import './style.css';

import { Application, Assets, Container, Rectangle, Sprite } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import { initDevtools } from '@pixi/devtools';
import { WORLD_HEIGHT, WORLD_WIDTH } from './PixiConfig.ts';
import {
	addRxPlugin,
	createRxDatabase,
	RxReplicationPullStreamItem,
} from 'rxdb';
import { Subject } from 'rxjs';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { replicateRxCollection } from 'rxdb/plugins/replication';
import PocketBase, { RecordListOptions } from 'pocketbase';
import { buildTreeSpriteGraph } from './tree.ts';

const pb = new PocketBase(`https://base.flora4fauna.net`);

const CULL_MARGIN = 1800;

async function setup(): Promise<[Application, Viewport]> {
	const app = new Application();

	await app.init({
		background: '#000000',
		resizeTo: window,
		backgroundAlpha: 0,
	});
	document.getElementById('app')?.appendChild(app.canvas);

	// ! Should be removed in prod
	void initDevtools({ app });

	const viewport = new Viewport({
		screenWidth: window.innerWidth,
		screenHeight: window.innerHeight,
		worldWidth: WORLD_WIDTH,
		worldHeight: WORLD_HEIGHT,
		events: app.renderer.events,
	});

	window.addEventListener('resize', () => {
		viewport.resize(window.innerWidth, window.innerHeight);
	});

	viewport
		.drag()
		.pinch()
		.decelerate()
		.wheel()
		.bounce({
			// @ts-expect-error this is enough for the bounce box
			bounceBox: {
				x: -viewport.worldWidth,
				width: viewport.worldWidth * 2,
				y: -viewport.worldHeight,
				height: viewport.worldHeight * 2,
			},
		})
		.clamp({
			left: -(viewport.worldWidth / 2),
			right: viewport.worldWidth * 1.5,
			top: -(viewport.worldHeight / 2),
			bottom: viewport.worldHeight * 1.5,
			underflow: 'none',
		})
		.clampZoom({ minScale: 0.1, maxScale: 10 });

	function cull(
		container: Container,
		view: Rectangle,
		skipUpdateTransform = true,
	) {
		if (
			container.cullable &&
			container.measurable &&
			container.includeInBuild
		) {
			const pos = viewport.toWorld(
				container.getGlobalPosition(undefined, skipUpdateTransform),
			);
			// TODO: Bounds don't seem to properly scale? Workaround using a margin for now
			const bounds =
				container.cullArea ?? container.getBounds(skipUpdateTransform);

			container.culled =
				pos.x >= view.x + view.width + CULL_MARGIN ||
				pos.y >= view.y + view.height + CULL_MARGIN ||
				pos.x + bounds.width + CULL_MARGIN <= view.x ||
				pos.y + bounds.height + CULL_MARGIN <= view.y;
		} else {
			container.culled = false;
		}

		if (
			!container.cullableChildren ||
			container.culled ||
			!container.renderable ||
			!container.measurable ||
			!container.includeInBuild
		)
			return;

		container.children.forEach((child) =>
			cull(child, view, skipUpdateTransform),
		);
	}

	app.ticker.add(() => {
		if (viewport.dirty) {
			const view = viewport.getVisibleBounds();
			viewport.children?.forEach((child) => cull(child, view));
			viewport.dirty = false;
		}
	});

	app.stage.addChild(viewport);

	return [app, viewport];
}

async function setupTextures() {
	await Assets.init({
		basePath: '/assets',
		manifest: '/assets/manifest.json',
	});

	await Assets.loadBundle('default', (progress) => {
		// TODO: Loading screen
		console.log('Load progress', progress);
	});
}

function setupTree(viewport: Viewport) {
	const bottomMiddleX = WORLD_WIDTH / 2;
	const bottomMiddleY = WORLD_HEIGHT * 0.9;

	const treeContainer = buildTreeSpriteGraph(bottomMiddleX, bottomMiddleY);
	treeContainer.cullableChildren = true;

	viewport.addChild(treeContainer);
	viewport.moveCenter(WORLD_WIDTH / 2, WORLD_HEIGHT * 0.9);
}

async function pixiMain() {
	const [app, viewport] = await setup();
	await setupTextures();
	setupTree(viewport);
}

interface Donation {
	username: string;
	message: string;
	amount: number;
	created: string;
	updated: string;
}

async function dataMain() {
	addRxPlugin(RxDBDevModePlugin);

	const db = await createRxDatabase({
		name: 'flora4fauna',
		storage: getRxStorageDexie(),
	});

	if (!db.donations) {
		await db.addCollections({
			donations: {
				schema: {
					version: 0,
					primaryKey: 'id',
					type: 'object',
					properties: {
						id: { type: 'string', maxLength: 15 },
						username: { type: 'string' },
						message: { type: 'string' },
						amount: { type: 'number' },
						created: { type: 'string' },
						updated: { type: 'string' },
					},
					required: [
						'id',
						'username',
						'message',
						'amount',
						'created',
						'updated',
					],
				},
			},
		});
	}

	const pullStream$ = new Subject<
		RxReplicationPullStreamItem<Donation, { updated: string }>
	>();

	const unsubscribe = await pb
		.collection('donations')
		.subscribe<Donation>('*', (e) => {
			pullStream$.next({
				documents: [{ ...e.record, _deleted: false }],
				checkpoint: { updated: e.record.updated },
			});
		});

	addEventListener('beforeunload', () => {
		void unsubscribe();
	});

	replicateRxCollection<Donation, { updated: string } | undefined>({
		collection: db.donations,
		replicationIdentifier: 'cms-donations-replication',
		pull: {
			async handler(checkpoint, batchSize) {
				const options: RecordListOptions = {
					sort: '-updated',
				};

				if (checkpoint) {
					options.filter = `(updated>'${checkpoint.updated}')`;
				}

				const result = await pb
					.collection('donations')
					.getList<Donation>(1, batchSize, options);

				return {
					documents: result.items.map((donation) => ({
						...donation,
						_deleted: false,
					})),
					checkpoint:
						result.items.length > 0 ?
							{ updated: result.items[0].updated }
						:	checkpoint,
				};
			},
			stream$: pullStream$,
		},
	});
}

void (async () => {
	await Promise.all([pixiMain(), dataMain()]);

	// Navbar logic
	const donateDialog = document.getElementById(
		'donate-dialog',
	)! as HTMLDialogElement;
	const donateBtn = document.getElementById('donate-btn')!;
	donateBtn.addEventListener('click', () => {
		donateDialog.showModal();
	});
})();
