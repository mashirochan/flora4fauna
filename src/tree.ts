import { Container, Sprite } from 'pixi.js';
import { Donation } from './donationPopup';
import Branch01 from './branches/Branch01.ts';
import Branch from './branches/Branch.ts';
import Database from './database.ts';
import LeafDatabase from './leafDatabase.ts';
import { RxChangeEventInsert } from 'rxdb';
import { Viewport } from 'pixi-viewport';

const TRUNK_ACTUAL_CENTERLINE = 1160;

// https://stackoverflow.com/a/7228322
function randomNumberFromInterval(min: number, max: number): number {
	// min and max included
	return Math.random() * (max - min + 1) + min;
}

function positionAndInsertSprite(
	container: Container,
	sprite: Sprite,
	anchorX: number,
	anchorY: number,
	x: number,
	y: number,
): Sprite {
	sprite.anchor.set(anchorX, anchorY);
	sprite.position.set(x, y);
	sprite.cullable = true;
	container.addChild(sprite);
	return sprite;
}

const BRANCH_OPTIONS: (new () => Branch)[] = [Branch01];

export async function buildTreeSpriteGraph(
	treeBottomX: number,
	treeBottomY: number,
	viewport: Viewport,
) {
	const treeContainer = new Container();

	// Build the base of the tree
	const treeBase = Sprite.from('Trunk_Flat_Base');
	positionAndInsertSprite(
		treeContainer,
		treeBase,
		0.5,
		1.0,
		treeBottomX - 75,
		treeBottomY,
	);
	positionAndInsertSprite(
		treeContainer,
		Sprite.from('Grass_Front'),
		0.5,
		1.0,
		treeBottomX,
		treeBottomY,
	);
	const faunaNemu = positionAndInsertSprite(
		treeContainer,
		Sprite.from('Fauna_Nemu'),
		0.5,
		1.0,
		treeBottomX,
		treeBottomY,
	);
	faunaNemu.zIndex = 2;

	const trunkTextureFunc = (currentTrunkCount: number) =>
		currentTrunkCount % 2 == 0 ? 'Trunk_Flat_Mid_01' : 'Trunk_Flat_Mid_02';
	const trunkSprites: Sprite[] = new Array<Sprite>();
	let trunkTopY = treeBottomY - treeBase.height;
	for (let trunkNum = 0; trunkNum < 2; trunkNum++) {
		const trunkSprite = Sprite.from(trunkTextureFunc(trunkNum));
		positionAndInsertSprite(
			treeContainer,
			trunkSprite,
			0.5,
			1.0,
			treeBottomX,
			trunkTopY,
		);
		trunkTopY -= trunkSprite.height;
		trunkSprites.push(trunkSprite);
	}

	const treeTop = positionAndInsertSprite(
		treeContainer,
		Sprite.from('Trunk_Flat_Top_01'),
		0.5,
		1.0,
		treeBottomX,
		trunkTopY,
	);

	const db = await Database();
	const initialDocs = (await db.donations.find().exec()) as (Donation & {
		id: string;
	})[];
	const leafDb = await LeafDatabase();

	// Build branches
	let isLeftBranch = true;
	let currentBranch: Branch | undefined;
	let leftBranchY =
		trunkSprites[1].position.y -
		trunkSprites[1].height / 2 -
		Math.floor(Math.random() * 200);
	let rightBranchY =
		trunkSprites[1].position.y -
		trunkSprites[1].height / 2 -
		Math.floor(Math.random() * 200);
	const trunkIndex = 1;
	let currentClampTopLimit = 0;
	// The tree in the texture is not in the actual center of the texture, so we need to calculate the actual center of the tree trunk.
	const actualTrunkCenter =
		treeBottomX +
		treeBase.width * (TRUNK_ACTUAL_CENTERLINE / treeBase.width - 0.5);

	function addDonation(donationId: string, donation: Donation) {
		if (!currentBranch || currentBranch.full) {
			currentBranch = new BRANCH_OPTIONS[
				Math.floor(Math.random() * BRANCH_OPTIONS.length)
			]();
			const bounds = currentBranch.getBounds(true);

			if (Math.min(leftBranchY - 200, rightBranchY - 200) < trunkTopY) {
				const trunkSprite = Sprite.from(trunkTextureFunc(trunkIndex));
				positionAndInsertSprite(
					treeContainer,
					trunkSprite,
					0.5,
					1.0,
					treeBottomX,
					trunkTopY,
				);
				trunkTopY -= trunkSprite.height;
				trunkSprites.push(trunkSprite);
				treeTop.y = trunkTopY;

				if (trunkTopY < currentClampTopLimit) {
					currentClampTopLimit = trunkTopY - 2000;

					viewport.plugins.remove('clamp');
					viewport.clamp({
						direction: 'all',
						underflow: 'center',
					});
				}
			}

			if (isLeftBranch) {
				currentBranch.position.set(actualTrunkCenter, leftBranchY);
				currentBranch.angle = 280 + randomNumberFromInterval(-5, 5);
				isLeftBranch = false;
				leftBranchY -=
					bounds.width + 600 + Math.floor(Math.random() * 1000);
			} else {
				currentBranch.position.set(actualTrunkCenter, rightBranchY);
				currentBranch.angle = 80 + randomNumberFromInterval(-5, 5);
				isLeftBranch = true;
				rightBranchY -=
					bounds.width + 600 + Math.floor(Math.random() * 1000);
			}
			treeContainer.addChild(currentBranch);
		}

		const { x, y, tint } = currentBranch.addDonation(donation);
		void leafDb.leaves.upsert({
			id: donationId,
			x: x,
			y: y,
			tint: tint,
		});
	}

	for (const doc of initialDocs) {
		addDonation(doc.id, doc as Donation);
	}

	db.donations.insert$.subscribe((event: RxChangeEventInsert<Donation>) => {
		addDonation(event.documentId, event.documentData);
	});

	return treeContainer;
}
