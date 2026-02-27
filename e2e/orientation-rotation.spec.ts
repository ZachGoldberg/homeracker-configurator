import { test, expect, clickCatalogItem } from "./fixtures";

test.describe("Orientation-aware grid occupancy", () => {
  test.beforeEach(async ({ appPage: page }) => {
    await page.evaluate(() => (window as any).__assembly.clear());
  });

  test("x-oriented support occupies cells along X axis", async ({
    appPage: page,
  }) => {
    const orientedId = await page.evaluate(() =>
      (window as any).__assembly.addPart("support-3u", [0, 0, 0], [0, 0, 0], "x")
    );
    expect(orientedId).not.toBeNull();

    // Cell [1,0,0] should be occupied — use a connector without -Y arm at Y=0
    const collisionAtX1 = await page.evaluate(() =>
      (window as any).__assembly.addPart("connector-2d2w", [1, 0, 0])
    );
    expect(collisionAtX1).toBeNull();

    // Cell [2,0,0] should also be occupied
    const collisionAtX2 = await page.evaluate(() =>
      (window as any).__assembly.addPart("connector-2d2w", [2, 0, 0])
    );
    expect(collisionAtX2).toBeNull();

    // Cell [0,1,0] should be free
    const freeAtY1 = await page.evaluate(() =>
      (window as any).__assembly.addPart("connector-3d6w", [0, 1, 0])
    );
    expect(freeAtY1).not.toBeNull();

    // Cell [0,0,1] should also be free
    const freeAtZ1 = await page.evaluate(() =>
      (window as any).__assembly.addPart("connector-2d2w", [0, 0, 1])
    );
    expect(freeAtZ1).not.toBeNull();
  });

  test("z-oriented support occupies cells along Z axis", async ({
    appPage: page,
  }) => {
    const orientedZ = await page.evaluate(() =>
      (window as any).__assembly.addPart("support-3u", [0, 0, 0], [0, 0, 0], "z")
    );
    expect(orientedZ).not.toBeNull();

    const collisionAtZ1 = await page.evaluate(() =>
      (window as any).__assembly.addPart("connector-2d2w", [0, 0, 1])
    );
    expect(collisionAtZ1).toBeNull();

    const freeAtY1 = await page.evaluate(() =>
      (window as any).__assembly.addPart("connector-3d6w", [0, 1, 0])
    );
    expect(freeAtY1).not.toBeNull();
  });
});

test.describe("canPlace with orientation", () => {
  test("validates placement considering orientation", async ({
    appPage: page,
  }) => {
    const results = await page.evaluate(() => {
      const a = (window as any).__assembly;
      a.clear();
      a.addPart("connector-3d6w", [3, 1, 0]);

      return {
        canPlaceY: a.canPlace("support-3u", [0, 0, 0], [0, 0, 0], "y"),
        canPlaceX: a.canPlace("support-3u", [0, 0, 0], [0, 0, 0], "x"),
        cannotPlaceXBlocked: a.canPlace("support-3u", [1, 1, 0], [0, 0, 0], "x"),
      };
    });

    expect(results.canPlaceY).toBe(true);
    expect(results.canPlaceX).toBe(true);
    expect(results.cannotPlaceXBlocked).toBe(false);
  });
});

test.describe("Rotation-aware grid collision", () => {
  test("90° X rotation moves cells from Y to Z axis", async ({
    appPage: page,
  }) => {
    const result = await page.evaluate(() => {
      const a = (window as any).__assembly;
      a.clear();

      // Place support-3u at [0,0,0] with 90° X rotation
      // Default gridCells: [0,0,0],[0,1,0],[0,2,0]
      // After 90° X: [x,y,z] → [x,-z,y], cells become [0,0,0],[0,0,1],[0,0,2]
      const id = a.addPart("support-3u", [0, 0, 0], [90, 0, 0]);

      const occupiedY1 = a.isOccupied([0, 1, 0]);
      const occupiedZ1 = a.isOccupied([0, 0, 1]);
      const occupiedZ2 = a.isOccupied([0, 0, 2]);

      // Use connector-2d2w (no -Y arm) for collision checks at Y=0
      const collidesZ1 = a.addPart("connector-2d2w", [0, 0, 1]);
      const freeY1 = a.addPart("connector-3d6w", [0, 1, 0]);

      return {
        placed: id !== null,
        occupiedY1,
        occupiedZ1,
        occupiedZ2,
        collidesZ1: collidesZ1 === null,
        freeY1: freeY1 !== null,
      };
    });

    expect(result.placed).toBe(true);
    expect(result.occupiedZ1).toBe(true);
    expect(result.occupiedZ2).toBe(true);
    expect(result.occupiedY1).toBe(false);
    expect(result.collidesZ1).toBe(true);
    expect(result.freeY1).toBe(true);
  });
});

test.describe("Rotation blocks below-ground placement", () => {
  test("180° X rotation at ground level is blocked", async ({
    appPage: page,
  }) => {
    const result = await page.evaluate(() => {
      const a = (window as any).__assembly;
      a.clear();

      // 90° X at ground: cells become [0,0,0],[0,0,1],[0,0,2] — all Y >= 0
      const validRot = a.canPlace("support-3u", [0, 0, 0], [90, 0, 0]);

      // 180° X at ground: [0,1,0] → [0,-1,0], [0,2,0] → [0,-2,0] — Y < 0
      const blockedRot = a.canPlace("support-3u", [0, 0, 0], [180, 0, 0]);

      return { validRot, blockedRot };
    });

    expect(result.validRot).toBe(true);
    expect(result.blockedRot).toBe(false);
  });
});

test.describe("Orientation keyboard hint", () => {
  test("support hint mentions orientation, connector mentions rotate", async ({
    appPage: page,
  }) => {
    await clickCatalogItem(page, "Support (3u)");
    const supportHint = await page.evaluate(
      () => document.querySelector(".viewport-hint")?.textContent?.trim() ?? ""
    );
    expect(supportHint).toContain("orientation");

    await clickCatalogItem(page, "3D 6-Way");
    const connectorHint = await page.evaluate(
      () => document.querySelector(".viewport-hint")?.textContent?.trim() ?? ""
    );
    expect(connectorHint).toContain("rotate");
    expect(connectorHint).not.toContain("orientation");

    await page.keyboard.press("Escape");
  });
});
