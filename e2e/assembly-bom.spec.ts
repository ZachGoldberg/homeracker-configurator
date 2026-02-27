import { test, expect, clickCatalogItem, getBBox } from "./fixtures";

test.describe("Place parts and BOM", () => {
  test.beforeEach(async ({ appPage: page }) => {
    await page.evaluate(() => (window as any).__assembly.clear());
    await page.waitForTimeout(200);
  });

  test("place connector and verify BOM", async ({ appPage: page }) => {
    const placed1 = await page.evaluate(() =>
      (window as any).__assembly.addPart("connector-3d6w", [0, 0, 0])
    );
    expect(placed1).not.toBeNull();
    await page.waitForTimeout(500);

    const bom1 = await page.evaluate(() => {
      const rows = document.querySelectorAll(".bom-table tbody tr");
      return Array.from(rows).map((row) => ({
        name: row.querySelector("td:first-child")?.textContent?.trim() ?? "",
        qty: row.querySelector(".bom-qty")?.textContent?.trim() ?? "",
      }));
    });

    expect(bom1.length).toBe(1);
    expect(bom1[0].name).toContain("6-Way");
    expect(bom1[0].qty).toBe("1");
  });

  test("place two connectors updates BOM quantity", async ({
    appPage: page,
  }) => {
    await page.evaluate(() => {
      const a = (window as any).__assembly;
      a.addPart("connector-3d6w", [0, 0, 0]);
      a.addPart("connector-3d6w", [1, 0, 0]);
    });
    await page.waitForTimeout(500);

    const bom = await page.evaluate(() => {
      const rows = document.querySelectorAll(".bom-table tbody tr");
      return Array.from(rows).map((row) => ({
        name: row.querySelector("td:first-child")?.textContent?.trim() ?? "",
        qty: row.querySelector(".bom-qty")?.textContent?.trim() ?? "",
      }));
    });

    expect(bom.some((r) => r.qty === "2")).toBe(true);
  });

  test("place mixed parts shows multiple BOM rows", async ({
    appPage: page,
  }) => {
    await page.evaluate(() => {
      const a = (window as any).__assembly;
      a.addPart("connector-3d6w", [0, 0, 0]);
      a.addPart("connector-3d6w", [1, 0, 0]);
      a.addPart("support-3u", [0, 1, 0]);
    });
    await page.waitForTimeout(500);

    const bom = await page.evaluate(() => {
      const rows = document.querySelectorAll(".bom-table tbody tr");
      return Array.from(rows).map((row) => ({
        name: row.querySelector("td:first-child")?.textContent?.trim() ?? "",
        qty: row.querySelector(".bom-qty")?.textContent?.trim() ?? "",
      }));
    });

    expect(bom.length).toBeGreaterThanOrEqual(2);
    expect(bom.some((r) => r.name.includes("Support"))).toBe(true);
  });

  test("BOM total shows parts count", async ({ appPage: page }) => {
    await page.evaluate(() => {
      const a = (window as any).__assembly;
      a.addPart("connector-3d6w", [0, 0, 0]);
      a.addPart("connector-3d6w", [1, 0, 0]);
      a.addPart("support-3u", [0, 1, 0]);
    });
    await page.waitForTimeout(500);

    const totalText = await page.evaluate(
      () => document.querySelector(".bom-total")?.textContent?.trim() ?? ""
    );
    expect(totalText).toContain("parts");
  });

  test("BOM lock pins with oriented supports", async ({
    appPage: page,
  }) => {
    await page.evaluate(() => {
      const a = (window as any).__assembly;
      a.addPart("connector-3d6w", [0, 0, 0]);
      a.addPart("support-3u", [1, 0, 0], [0, 0, 0], "x");
    });
    await page.waitForTimeout(500);

    const bom = await page.evaluate(() => {
      const rows = document.querySelectorAll(".bom-table tbody tr");
      return Array.from(rows).map((row) => ({
        name: row.querySelector("td:first-child")?.textContent?.trim() ?? "",
        qty: row.querySelector(".bom-qty")?.textContent?.trim() ?? "",
      }));
    });

    expect(bom.some((r) => r.name.includes("Lock Pin"))).toBe(true);
  });
});

test.describe("Collision detection", () => {
  test("cannot place on occupied position", async ({ appPage: page }) => {
    await page.evaluate(() => (window as any).__assembly.clear());
    await page.evaluate(() =>
      (window as any).__assembly.addPart("connector-3d6w", [0, 0, 0])
    );

    const collision = await page.evaluate(() =>
      (window as any).__assembly.addPart("connector-2d2w", [0, 0, 0])
    );
    expect(collision).toBeNull();
  });
});

test.describe("Clear All", () => {
  test("clears assembly and BOM", async ({ appPage: page }) => {
    await page.evaluate(() => {
      const a = (window as any).__assembly;
      a.clear();
      a.addPart("connector-2d4w", [0, 0, 0]);
    });
    await page.waitForTimeout(300);

    // Click Clear All button
    await page.evaluate(() => {
      const buttons = document.querySelectorAll(".toolbar-btn");
      for (const btn of buttons) {
        if (btn.textContent?.trim() === "Clear All") {
          (btn as HTMLElement).click();
          return;
        }
      }
    });
    await page.waitForTimeout(500);

    const afterClear = await page.evaluate(() => {
      const emptyMsg = document.querySelector(".bom-empty");
      const rows = document.querySelectorAll(".bom-table tbody tr");
      const partCount = (window as any).__assembly.getAllParts().length;
      return {
        emptyMsgVisible: !!emptyMsg,
        rowCount: rows.length,
        partCount,
      };
    });

    expect(afterClear.partCount).toBe(0);
    expect(afterClear.emptyMsgVisible).toBe(true);
    expect(afterClear.rowCount).toBe(0);
  });

  test("can place at cleared positions", async ({ appPage: page }) => {
    await page.evaluate(() => {
      const a = (window as any).__assembly;
      a.clear();
      a.addPart("connector-2d4w", [0, 0, 0]);
      a.clear();
    });
    await page.waitForTimeout(200);

    const result = await page.evaluate(() =>
      (window as any).__assembly.addPart("connector-2d4w", [0, 0, 0])
    );
    expect(result).not.toBeNull();
  });
});

test.describe("Remove part", () => {
  test("removes part and frees position", async ({ appPage: page }) => {
    await page.evaluate(() => {
      (window as any).__assembly.clear();
      (window as any).__assembly.addPart("connector-2d4w", [0, 0, 0]);
    });

    const result = await page.evaluate(() => {
      const assembly = (window as any).__assembly;
      const parts = assembly.getAllParts();
      if (parts.length === 0) return { removed: false, remaining: 0 };
      const removed = assembly.removePart(parts[0].instanceId);
      return { removed: !!removed, remaining: assembly.getAllParts().length };
    });

    expect(result.removed).toBe(true);
    expect(result.remaining).toBe(0);
  });
});

test.describe("Placed part orientation matches ghost", () => {
  test("support-3u vertical orientation", async ({ appPage: page }) => {
    await page.evaluate(() => (window as any).__assembly.clear());

    // Enter placement mode for support-3u
    await clickCatalogItem(page, "Support (3u)");
    await page.waitForTimeout(1000);

    const ghostBBox = await getBBox(page, "ghost-preview");
    expect(ghostBBox).not.toBeNull();
    if (ghostBBox) {
      expect(ghostBBox.sizeY).toBeGreaterThan(ghostBBox.sizeX * 2);
    }

    // Exit and place via API
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    const supportId = await page.evaluate(() =>
      (window as any).__assembly.addPart("support-3u", [0, 0, 0])
    );
    expect(supportId).not.toBeNull();

    // Wait for GLB model to load
    await page.waitForTimeout(3000);

    const placedBBox = await getBBox(page, `placed-${supportId}`);
    expect(placedBBox).not.toBeNull();
    if (placedBBox) {
      expect(placedBBox.sizeY).toBeGreaterThan(placedBBox.sizeX * 2);
      expect(placedBBox.sizeY).toBeGreaterThan(placedBBox.sizeZ * 2);
    }

    if (ghostBBox && placedBBox) {
      const ghostTallAxis =
        ghostBBox.sizeY > ghostBBox.sizeX && ghostBBox.sizeY > ghostBBox.sizeZ
          ? "Y"
          : ghostBBox.sizeX > ghostBBox.sizeZ
            ? "X"
            : "Z";
      const placedTallAxis =
        placedBBox.sizeY > placedBBox.sizeX &&
        placedBBox.sizeY > placedBBox.sizeZ
          ? "Y"
          : placedBBox.sizeX > placedBBox.sizeZ
            ? "X"
            : "Z";
      expect(ghostTallAxis).toBe(placedTallAxis);
    }
  });
});
