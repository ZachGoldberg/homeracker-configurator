import { test, expect } from "./fixtures";

test.describe("Sparse collision: perpendicular supports can cross", () => {
  test.beforeEach(async ({ appPage: page }) => {
    await page.evaluate(() => (window as any).__assembly.clear());
    await page.waitForTimeout(200);
  });

  test("vertical and horizontal supports can share a cell", async ({
    appPage: page,
  }) => {
    // Place a vertical support (y-oriented) spanning cells [0,0,0] to [0,4,0]
    const verticalId = await page.evaluate(() =>
      (window as any).__assembly.addPart("support-5u", [0, 0, 0], [0, 0, 0], "y")
    );
    expect(verticalId).not.toBeNull();

    // Place a horizontal support (x-oriented) at [0,2,0] spanning [-2..2, 2, 0]
    // This crosses the vertical support at cell [0,2,0]
    const horizontalId = await page.evaluate(() =>
      (window as any).__assembly.addPart("support-5u", [-2, 2, 0], [0, 0, 0], "x")
    );

    // Currently fails because cell [0,2,0] is occupied by the vertical support.
    // After the fix, this should succeed because supports on different axes
    // are thin bars that don't physically collide.
    expect(horizontalId).not.toBeNull();
  });

  test("three perpendicular supports can all share one cell", async ({
    appPage: page,
  }) => {
    // Place Y-axis support spanning [0,0,0] to [0,2,0]
    const yId = await page.evaluate(() =>
      (window as any).__assembly.addPart("support-3u", [0, 0, 0], [0, 0, 0], "y")
    );
    expect(yId).not.toBeNull();

    // Place X-axis support crossing at [0,1,0]
    const xId = await page.evaluate(() =>
      (window as any).__assembly.addPart("support-3u", [-1, 1, 0], [0, 0, 0], "x")
    );
    expect(xId).not.toBeNull();

    // Place Z-axis support also crossing at [0,1,0]
    const zId = await page.evaluate(() =>
      (window as any).__assembly.addPart("support-3u", [0, 1, -1], [0, 0, 0], "z")
    );
    expect(zId).not.toBeNull();
  });

  test("same-axis supports still cannot overlap", async ({
    appPage: page,
  }) => {
    // Place a vertical support at [0,0,0]
    const id1 = await page.evaluate(() =>
      (window as any).__assembly.addPart("support-5u", [0, 0, 0], [0, 0, 0], "y")
    );
    expect(id1).not.toBeNull();

    // Place another vertical support overlapping at [0,0,0] - should still fail
    const id2 = await page.evaluate(() =>
      (window as any).__assembly.addPart("support-3u", [0, 0, 0], [0, 0, 0], "y")
    );
    expect(id2).toBeNull();
  });

  test("connector still blocks all axes at its cell", async ({
    appPage: page,
  }) => {
    // Connector at [0,1,0] — use Y=1 so 6-way arms don't extend below ground
    const connId = await page.evaluate(() =>
      (window as any).__assembly.addPart("connector-3d6w", [0, 1, 0])
    );
    expect(connId).not.toBeNull();

    // Support crossing through the connector cell should still be blocked
    const supportId = await page.evaluate(() =>
      (window as any).__assembly.addPart("support-3u", [-1, 1, 0], [0, 0, 0], "x")
    );
    expect(supportId).toBeNull();
  });

  test("support cannot cross through a connector", async ({
    appPage: page,
  }) => {
    // Use a 2d4w connector (no -y arm) so it can sit at Y=2
    const connId = await page.evaluate(() =>
      (window as any).__assembly.addPart("connector-2d4w", [0, 2, 0])
    );
    expect(connId).not.toBeNull();

    // Vertical support spanning through [0,2,0] should be blocked
    const supportId = await page.evaluate(() =>
      (window as any).__assembly.addPart("support-5u", [0, 0, 0], [0, 0, 0], "y")
    );
    expect(supportId).toBeNull();
  });

  test("canPlaceIgnoring works with sparse cells during drag", async ({
    appPage: page,
  }) => {
    // Place two crossing supports
    const yId = await page.evaluate(() =>
      (window as any).__assembly.addPart("support-5u", [0, 0, 0], [0, 0, 0], "y")
    );
    expect(yId).not.toBeNull();

    const xId = await page.evaluate(() =>
      (window as any).__assembly.addPart("support-5u", [-2, 2, 0], [0, 0, 0], "x")
    );
    expect(xId).not.toBeNull();

    // canPlaceIgnoring should let us "move" the x-support back to its own position
    const canMove = await page.evaluate((id: string) =>
      (window as any).__assembly.canPlaceIgnoring(
        "support-5u", [-2, 2, 0], [0, 0, 0], id, "x"
      ),
      xId!
    );
    expect(canMove).toBe(true);
  });
});
