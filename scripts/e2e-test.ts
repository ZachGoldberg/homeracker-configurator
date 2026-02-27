/// E2E test: loads the UI, clicks catalog items, places parts, verifies BOM

import { join } from "path";
import puppeteer from "puppeteer";

const PROJECT_ROOT = join(import.meta.dir, "..");
const DIST_DIR = join(PROJECT_ROOT, "dist");
const PUBLIC_DIR = join(PROJECT_ROOT, "public");
const HEADED = process.env.HEADED === "1" || process.env.HEADED === "true";

let exitCode = 0;
const results: { name: string; pass: boolean; detail?: string }[] = [];

function assert(name: string, condition: boolean, detail?: string) {
  results.push({ name, pass: condition, detail });
  if (!condition) {
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    exitCode = 1;
  } else {
    console.log(`  PASS: ${name}`);
  }
}

// Build
console.log("=== Building ===");
const buildResult = await Bun.build({
  entrypoints: [join(PROJECT_ROOT, "src", "main.tsx")],
  outdir: DIST_DIR,
  naming: "[name].[ext]",
  sourcemap: "linked",
  define: { "process.env.NODE_ENV": JSON.stringify("development") },
});
if (!buildResult.success) {
  for (const log of buildResult.logs) console.error(log);
  process.exit(1);
}
console.log("Build OK\n");

// Serve
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = url.pathname;

    if (pathname.startsWith("/src/") && /\.(tsx?|jsx?)$/.test(pathname)) {
      const mapped = pathname.replace("/src/", "").replace(".tsx", ".js").replace(".ts", ".js");
      const file = Bun.file(join(DIST_DIR, mapped));
      if (await file.exists()) return new Response(file, { headers: { "Content-Type": "application/javascript" } });
    }

    if (pathname !== "/" && pathname !== "/index.html") {
      for (const dir of [PUBLIC_DIR, PROJECT_ROOT, DIST_DIR]) {
        const file = Bun.file(join(dir, pathname));
        if (await file.exists()) return new Response(file);
      }
    }

    const html = await Bun.file(join(PROJECT_ROOT, "index.html")).text();
    return new Response(
      html.replace('src="/src/main.tsx"', 'src="/src/main.js"'),
      { headers: { "Content-Type": "text/html" } }
    );
  },
});

const baseUrl = `http://localhost:${server.port}`;
console.log(`Server on ${baseUrl}\n`);

// Launch browser
const browser = await puppeteer.launch({
  headless: !HEADED,
  slowMo: HEADED ? 50 : 0,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--enable-webgl",
    ...(HEADED ? [] : ["--use-gl=angle", "--use-angle=swiftshader"]),
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const pageErrors: string[] = [];
page.on("pageerror", (err) => {
  // Ignore WebGL errors — expected in headless
  if (err.message.includes("WebGL")) return;
  pageErrors.push(err.message);
  console.error("[PAGE ERR]", err.message);
});

console.log("=== Loading page ===");
await page.goto(baseUrl, { waitUntil: "networkidle0", timeout: 15000 });
await new Promise((r) => setTimeout(r, 1500));

// ──────────────────────────────────────────────
// Test 1: Layout loads correctly
// ──────────────────────────────────────────────
console.log("\n--- Test: Layout ---");

const layout = await page.evaluate(() => {
  return {
    app: !!document.querySelector(".app"),
    sidebar: !!document.querySelector(".sidebar"),
    mainArea: !!document.querySelector(".main-area"),
    toolbar: !!document.querySelector(".toolbar"),
    viewport: !!document.querySelector(".viewport"),
    bomPanel: !!document.querySelector(".bom-panel"),
  };
});

assert("App container renders", layout.app);
assert("Sidebar renders", layout.sidebar);
assert("Main area renders", layout.mainArea);
assert("Toolbar renders", layout.toolbar);
assert("Viewport renders", layout.viewport);
assert("BOM panel renders", layout.bomPanel);

// ──────────────────────────────────────────────
// Test 2: Catalog items present
// ──────────────────────────────────────────────
console.log("\n--- Test: Catalog ---");

const catalogItems = await page.evaluate(() => {
  const items = document.querySelectorAll(".catalog-item");
  return Array.from(items).map((el) => ({
    name: el.querySelector(".catalog-item-name")?.textContent?.trim() ?? "",
    active: el.classList.contains("active"),
  }));
});

assert("Catalog has 8 items (4 connectors + 3 supports + 1 lockpin)", catalogItems.length === 8, `got ${catalogItems.length}`);
assert("No item is active initially", catalogItems.every((i) => !i.active));

const expectedParts = ["2D 2-Way", "2D 4-Way", "3D 4-Way", "3D 6-Way", "Support (3u)", "Support (5u)", "Support (10u)", "Lock Pin"];
for (const name of expectedParts) {
  assert(`Catalog contains "${name}"`, catalogItems.some((i) => i.name === name));
}

// ──────────────────────────────────────────────
// Test 3: Clicking a catalog item enters placement mode
// ──────────────────────────────────────────────
console.log("\n--- Test: Placement mode ---");

// Click the "3D 6-Way" connector (4th catalog item)
const connector6WayBtn = await page.$('.catalog-item:nth-child(4)');
if (connector6WayBtn) {
  // First, find the correct button by text
  await page.evaluate(() => {
    const items = document.querySelectorAll(".catalog-item");
    for (const item of items) {
      if (item.querySelector(".catalog-item-name")?.textContent?.trim() === "3D 6-Way") {
        (item as HTMLElement).click();
        return;
      }
    }
  });
  await new Promise((r) => setTimeout(r, 300));

  const afterClick = await page.evaluate(() => {
    const items = document.querySelectorAll(".catalog-item");
    const activeItem = Array.from(items).find((el) => el.classList.contains("active"));
    const hint = document.querySelector(".viewport-hint");
    return {
      activeName: activeItem?.querySelector(".catalog-item-name")?.textContent?.trim() ?? null,
      hintVisible: !!hint,
      hintText: hint?.textContent?.trim() ?? null,
    };
  });

  assert("3D 6-Way becomes active after click", afterClick.activeName === "3D 6-Way", `active: ${afterClick.activeName}`);
  assert("Viewport hint appears in placement mode", afterClick.hintVisible);
  assert("Hint says click to place", afterClick.hintText?.includes("Click to place") ?? false, afterClick.hintText ?? "no hint");
}

// Press Escape to exit placement mode
await page.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 300));

const afterEscape = await page.evaluate(() => {
  const items = document.querySelectorAll(".catalog-item");
  const activeItem = Array.from(items).find((el) => el.classList.contains("active"));
  const hint = document.querySelector(".viewport-hint");
  return {
    anyActive: !!activeItem,
    hintVisible: !!hint,
  };
});

assert("Escape exits placement mode (no active item)", !afterEscape.anyActive);
assert("Viewport hint disappears after Escape", !afterEscape.hintVisible);

// ──────────────────────────────────────────────
// Test: Ghost preview matches selected catalog item
// ──────────────────────────────────────────────
console.log("\n--- Test: Ghost preview model ---");

// Click each catalog item and verify data-placing attribute matches
const partIds = await page.evaluate(() => {
  const items = document.querySelectorAll(".catalog-item");
  return Array.from(items).map((el) => {
    const name = el.querySelector(".catalog-item-name")?.textContent?.trim() ?? "";
    return name;
  });
});

const partNameToId: Record<string, string> = {
  "2D 2-Way": "connector-2d2w",
  "2D 4-Way": "connector-2d4w",
  "3D 4-Way": "connector-3d4w",
  "3D 6-Way": "connector-3d6w",
  "Support (3u)": "support-3u",
  "Support (5u)": "support-5u",
  "Support (10u)": "support-10u",
  "Lock Pin": "lockpin-standard",
};

for (const partName of partIds) {
  const expectedId = partNameToId[partName];
  if (!expectedId) continue;

  // Click this catalog item
  await page.evaluate((name: string) => {
    const items = document.querySelectorAll(".catalog-item");
    for (const item of items) {
      if (item.querySelector(".catalog-item-name")?.textContent?.trim() === name) {
        (item as HTMLElement).click();
        return;
      }
    }
  }, partName);
  await new Promise((r) => setTimeout(r, 200));

  const placing = await page.evaluate(() => {
    return document.querySelector(".viewport")?.getAttribute("data-placing") ?? null;
  });

  assert(`Ghost preview for "${partName}" uses ${expectedId}`, placing === expectedId, `got: ${placing}`);
}

// Exit placement mode for next tests
await page.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 200));

const noGhostAfterEscape = await page.evaluate(() => {
  return document.querySelector(".viewport")?.getAttribute("data-placing") ?? null;
});
assert("No ghost preview after Escape", noGhostAfterEscape === null);

// ──────────────────────────────────────────────
// Test 4: Programmatically place parts via assembly API, verify BOM
// ──────────────────────────────────────────────
console.log("\n--- Test: Place parts + BOM ---");

// Place a 3D 6-Way connector at origin
const placed1 = await page.evaluate(() => {
  return (window as any).__assembly.addPart("connector-3d6w", [0, 0, 0]);
});
assert("Place connector-3d6w at [0,0,0] succeeds", placed1 !== null, `id: ${placed1}`);
await new Promise((r) => setTimeout(r, 500));

// Check BOM updated
const bom1 = await page.evaluate(() => {
  const rows = document.querySelectorAll(".bom-table tbody tr");
  return Array.from(rows).map((row) => ({
    name: row.querySelector("td:first-child")?.textContent?.trim() ?? "",
    qty: row.querySelector(".bom-qty")?.textContent?.trim() ?? "",
  }));
});

assert("BOM shows 1 row after placing one part", bom1.length === 1, `got ${bom1.length} rows`);
if (bom1.length > 0) {
  assert("BOM row is 3D 6-Way", bom1[0].name.includes("6-Way"), bom1[0].name);
  assert("BOM quantity is 1", bom1[0].qty === "1", bom1[0].qty);
}

// Place a second connector at a different position
const placed2 = await page.evaluate(() => {
  return (window as any).__assembly.addPart("connector-3d6w", [1, 0, 0]);
});
assert("Place connector-3d6w at [1,0,0] succeeds", placed2 !== null);
await new Promise((r) => setTimeout(r, 500));

const bom2 = await page.evaluate(() => {
  const rows = document.querySelectorAll(".bom-table tbody tr");
  return Array.from(rows).map((row) => ({
    name: row.querySelector("td:first-child")?.textContent?.trim() ?? "",
    qty: row.querySelector(".bom-qty")?.textContent?.trim() ?? "",
  }));
});

assert("BOM quantity updates to 2", bom2.some((r) => r.qty === "2"), `rows: ${JSON.stringify(bom2)}`);

// Place a support between them
const placed3 = await page.evaluate(() => {
  return (window as any).__assembly.addPart("support-3u", [0, 1, 0]);
});
assert("Place support-3u at [0,1,0] succeeds", placed3 !== null);
await new Promise((r) => setTimeout(r, 500));

const bom3 = await page.evaluate(() => {
  const rows = document.querySelectorAll(".bom-table tbody tr");
  return Array.from(rows).map((row) => ({
    name: row.querySelector("td:first-child")?.textContent?.trim() ?? "",
    qty: row.querySelector(".bom-qty")?.textContent?.trim() ?? "",
  }));
});

assert("BOM shows at least 2 rows (connector + support)", bom3.length >= 2, `got ${bom3.length}`);
assert("BOM includes support", bom3.some((r) => r.name.includes("Support")), `rows: ${JSON.stringify(bom3)}`);

// ──────────────────────────────────────────────
// Test 5: Collision detection
// ──────────────────────────────────────────────
console.log("\n--- Test: Collision detection ---");

const collision = await page.evaluate(() => {
  return (window as any).__assembly.addPart("connector-2d2w", [0, 0, 0]);
});
assert("Cannot place on occupied position [0,0,0]", collision === null);

// ──────────────────────────────────────────────
// Test 6: BOM total count
// ──────────────────────────────────────────────
console.log("\n--- Test: BOM totals ---");

const totalText = await page.evaluate(() => {
  return document.querySelector(".bom-total")?.textContent?.trim() ?? "";
});
// We placed 2 connectors + 1 support (3u spans 3 cells) = 3 parts
assert("BOM total shows parts count", totalText.includes("parts"), totalText);

// ──────────────────────────────────────────────
// Test 7: Clear all
// ──────────────────────────────────────────────
console.log("\n--- Test: Clear All ---");

// Click "Clear All" toolbar button
await page.evaluate(() => {
  const buttons = document.querySelectorAll(".toolbar-btn");
  for (const btn of buttons) {
    if (btn.textContent?.trim() === "Clear All") {
      (btn as HTMLElement).click();
      return;
    }
  }
});
await new Promise((r) => setTimeout(r, 500));

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

assert("Assembly is empty after Clear All", afterClear.partCount === 0);
assert("BOM shows empty message", afterClear.emptyMsgVisible);
assert("BOM table has no rows", afterClear.rowCount === 0);

// ──────────────────────────────────────────────
// Test 8: Place after clear (re-use positions)
// ──────────────────────────────────────────────
console.log("\n--- Test: Place after clear ---");

const replaceResult = await page.evaluate(() => {
  return (window as any).__assembly.addPart("connector-2d4w", [0, 0, 0]);
});
assert("Can place at [0,0,0] after clear", replaceResult !== null);

// ──────────────────────────────────────────────
// Test 9: Remove a part
// ──────────────────────────────────────────────
console.log("\n--- Test: Remove part ---");

const removeResult = await page.evaluate(() => {
  const assembly = (window as any).__assembly;
  const parts = assembly.getAllParts();
  if (parts.length === 0) return { removed: false, remaining: 0 };
  const removed = assembly.removePart(parts[0].instanceId);
  return { removed: !!removed, remaining: assembly.getAllParts().length };
});

assert("Part removed successfully", removeResult.removed);
assert("Assembly is empty after removal", removeResult.remaining === 0);

// ──────────────────────────────────────────────
// Test 10: Switching between catalog items
// ──────────────────────────────────────────────
console.log("\n--- Test: Catalog switching ---");

// Click Support (5u)
await page.evaluate(() => {
  const items = document.querySelectorAll(".catalog-item");
  for (const item of items) {
    if (item.querySelector(".catalog-item-name")?.textContent?.trim() === "Support (5u)") {
      (item as HTMLElement).click();
      return;
    }
  }
});
await new Promise((r) => setTimeout(r, 300));

const active1 = await page.evaluate(() => {
  const active = document.querySelector(".catalog-item.active .catalog-item-name");
  return active?.textContent?.trim() ?? null;
});
assert("Support (5u) is active", active1 === "Support (5u)", `active: ${active1}`);

// Click a different item — Lock Pin
await page.evaluate(() => {
  const items = document.querySelectorAll(".catalog-item");
  for (const item of items) {
    if (item.querySelector(".catalog-item-name")?.textContent?.trim() === "Lock Pin") {
      (item as HTMLElement).click();
      return;
    }
  }
});
await new Promise((r) => setTimeout(r, 300));

const active2 = await page.evaluate(() => {
  const active = document.querySelector(".catalog-item.active .catalog-item-name");
  return active?.textContent?.trim() ?? null;
});
assert("Lock Pin is now active (switched from Support)", active2 === "Lock Pin", `active: ${active2}`);

// ──────────────────────────────────────────────
// Test: Placed part orientation matches ghost preview
// ──────────────────────────────────────────────
console.log("\n--- Test: Placed part orientation matches ghost ---");

// Helper: get a named object's world-space bounding box from the Three.js scene
const getBBox = async (objectName: string) => {
  return page.evaluate((name: string) => {
    const scene = (window as any).__scene;
    if (!scene) return null;
    let target: any = null;
    scene.traverse((obj: any) => {
      if (obj.name === name) target = obj;
    });
    if (!target) return null;

    // Force matrix recomputation on entire subtree (R3F sets matrixAutoUpdate=false)
    const forceUpdateMatrices = (obj: any) => {
      // Walk up parent chain, force updateMatrix on each
      const chain: any[] = [];
      let p = obj;
      while (p) { chain.unshift(p); p = p.parent; }
      for (const node of chain) {
        node.updateMatrix();
      }
      // Now compute world matrices top-down
      for (let i = 0; i < chain.length; i++) {
        if (i === 0) {
          chain[i].matrixWorld.copy(chain[i].matrix);
        } else {
          chain[i].matrixWorld.multiplyMatrices(chain[i - 1].matrixWorld, chain[i].matrix);
        }
      }
    };

    // Compute world bounding box by traversing meshes
    const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    target.traverse((child: any) => {
      if (child.isMesh && child.geometry) {
        forceUpdateMatrices(child);
        if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
        const bb = child.geometry.boundingBox;
        // Transform bounding box corners to world space
        const corners = [
          [bb.min.x, bb.min.y, bb.min.z],
          [bb.max.x, bb.min.y, bb.min.z],
          [bb.min.x, bb.max.y, bb.min.z],
          [bb.max.x, bb.max.y, bb.min.z],
          [bb.min.x, bb.min.y, bb.max.z],
          [bb.max.x, bb.min.y, bb.max.z],
          [bb.min.x, bb.max.y, bb.max.z],
          [bb.max.x, bb.max.y, bb.max.z],
        ];
        for (const c of corners) {
          const v = { x: c[0], y: c[1], z: c[2] };
          // Apply world matrix manually
          const e = child.matrixWorld.elements;
          const wx = e[0]*v.x + e[4]*v.y + e[8]*v.z + e[12];
          const wy = e[1]*v.x + e[5]*v.y + e[9]*v.z + e[13];
          const wz = e[2]*v.x + e[6]*v.y + e[10]*v.z + e[14];
          box.min[0] = Math.min(box.min[0], wx);
          box.min[1] = Math.min(box.min[1], wy);
          box.min[2] = Math.min(box.min[2], wz);
          box.max[0] = Math.max(box.max[0], wx);
          box.max[1] = Math.max(box.max[1], wy);
          box.max[2] = Math.max(box.max[2], wz);
        }
      }
    });
    if (box.min[0] === Infinity) return null;
    return {
      sizeX: Math.round((box.max[0] - box.min[0]) * 100) / 100,
      sizeY: Math.round((box.max[1] - box.min[1]) * 100) / 100,
      sizeZ: Math.round((box.max[2] - box.min[2]) * 100) / 100,
    };
  }, objectName);
};

// Clear everything first
await page.evaluate(() => (window as any).__assembly.clear());
await new Promise((r) => setTimeout(r, 300));

// Step 1: Enter placement mode for support-3u and get the ghost bbox
await page.evaluate(() => {
  const items = document.querySelectorAll(".catalog-item");
  for (const item of items) {
    if (item.querySelector(".catalog-item-name")?.textContent?.trim() === "Support (3u)") {
      (item as HTMLElement).click();
      return;
    }
  }
});
await new Promise((r) => setTimeout(r, 1000));

const ghostBBox = await getBBox("ghost-preview");
console.log(`  Ghost bbox: ${JSON.stringify(ghostBBox)}`);
assert("Ghost preview found in scene", ghostBBox !== null);

if (ghostBBox) {
  assert(
    "Ghost preview is taller in Y than X (vertical orientation)",
    ghostBBox.sizeY > ghostBBox.sizeX * 2,
    `Y=${ghostBBox.sizeY} X=${ghostBBox.sizeX}`
  );
}

// Step 2: Exit placement mode and place the part via API
await page.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 200));

const supportId = await page.evaluate(() => {
  return (window as any).__assembly.addPart("support-3u", [0, 0, 0]);
});
assert("Support-3u placed", supportId !== null);

// Wait for GLB model to load
await new Promise((r) => setTimeout(r, 3000));

// Step 3: Find the placed part's bbox
const placedBBox = await getBBox(`placed-${supportId}`);
console.log(`  Placed bbox: ${JSON.stringify(placedBBox)}`);
assert("Placed part found in scene", placedBBox !== null);

if (placedBBox) {
  assert(
    "Placed part is taller in Y than X (vertical, matching ghost)",
    placedBBox.sizeY > placedBBox.sizeX * 2,
    `Y=${placedBBox.sizeY} X=${placedBBox.sizeX}`
  );
  assert(
    "Placed part is taller in Y than Z (vertical, matching ghost)",
    placedBBox.sizeY > placedBBox.sizeZ * 2,
    `Y=${placedBBox.sizeY} Z=${placedBBox.sizeZ}`
  );
}

// Step 4: If both exist, compare that the tallest axis is the same
if (ghostBBox && placedBBox) {
  const ghostTallAxis = ghostBBox.sizeY > ghostBBox.sizeX && ghostBBox.sizeY > ghostBBox.sizeZ ? "Y"
    : ghostBBox.sizeX > ghostBBox.sizeZ ? "X" : "Z";
  const placedTallAxis = placedBBox.sizeY > placedBBox.sizeX && placedBBox.sizeY > placedBBox.sizeZ ? "Y"
    : placedBBox.sizeX > placedBBox.sizeZ ? "X" : "Z";
  assert(
    `Ghost and placed part share tallest axis`,
    ghostTallAxis === placedTallAxis,
    `ghost=${ghostTallAxis} placed=${placedTallAxis}`
  );
}

// Clean up for remaining tests
await page.evaluate(() => (window as any).__assembly.clear());
await new Promise((r) => setTimeout(r, 300));

// ──────────────────────────────────────────────
// Test: Orientation-aware grid occupancy
// ──────────────────────────────────────────────
console.log("\n--- Test: Orientation-aware grid occupancy ---");

// Place support-3u with orientation "x" — should occupy [0,0,0],[1,0,0],[2,0,0]
const orientedId = await page.evaluate(() => {
  const a = (window as any).__assembly;
  a.clear();
  return a.addPart("support-3u", [0, 0, 0], [0, 0, 90], "x");
});
assert("Place support-3u with orientation x", orientedId !== null);

// Cell [1,0,0] should be occupied — try placing a connector there
const collisionAtX1 = await page.evaluate(() => {
  return (window as any).__assembly.addPart("connector-3d6w", [1, 0, 0]);
});
assert("Collision at [1,0,0] with x-oriented support", collisionAtX1 === null);

// Cell [2,0,0] should also be occupied
const collisionAtX2 = await page.evaluate(() => {
  return (window as any).__assembly.addPart("connector-3d6w", [2, 0, 0]);
});
assert("Collision at [2,0,0] with x-oriented support", collisionAtX2 === null);

// Cell [0,1,0] should be free (support extends along X, not Y)
const freeAtY1 = await page.evaluate(() => {
  return (window as any).__assembly.addPart("connector-3d6w", [0, 1, 0]);
});
assert("No collision at [0,1,0] with x-oriented support", freeAtY1 !== null);

// Cell [0,0,1] should also be free
const freeAtZ1 = await page.evaluate(() => {
  return (window as any).__assembly.addPart("connector-3d6w", [0, 0, 1]);
});
assert("No collision at [0,0,1] with x-oriented support", freeAtZ1 !== null);

// Test Z orientation
await page.evaluate(() => (window as any).__assembly.clear());
const orientedZ = await page.evaluate(() => {
  return (window as any).__assembly.addPart("support-3u", [0, 0, 0], [90, 0, 0], "z");
});
assert("Place support-3u with orientation z", orientedZ !== null);

const collisionAtZ1 = await page.evaluate(() => {
  return (window as any).__assembly.addPart("connector-3d6w", [0, 0, 1]);
});
assert("Collision at [0,0,1] with z-oriented support", collisionAtZ1 === null);

const freeAtY1Z = await page.evaluate(() => {
  return (window as any).__assembly.addPart("connector-3d6w", [0, 1, 0]);
});
assert("No collision at [0,1,0] with z-oriented support", freeAtY1Z !== null);

// Clean up
await page.evaluate(() => (window as any).__assembly.clear());
await new Promise((r) => setTimeout(r, 200));

// ──────────────────────────────────────────────
// Test: canPlace with orientation parameter
// ──────────────────────────────────────────────
console.log("\n--- Test: canPlace with orientation ---");

const canPlaceResults = await page.evaluate(() => {
  const a = (window as any).__assembly;
  a.clear();
  // Place a connector at [3,0,0]
  a.addPart("connector-3d6w", [3, 0, 0]);

  return {
    // A support-3u at [0,0,0] with orientation Y occupies [0,0,0],[0,1,0],[0,2,0]
    canPlaceY: a.canPlace("support-3u", [0, 0, 0], "y"),
    // A support-3u at [0,0,0] with orientation X occupies [0,0,0],[1,0,0],[2,0,0]
    canPlaceX: a.canPlace("support-3u", [0, 0, 0], "x"),
    // A support-3u at [1,0,0] with orientation X would need [1,0,0],[2,0,0],[3,0,0] - [3,0,0] is occupied
    cannotPlaceXBlocked: a.canPlace("support-3u", [1, 0, 0], "x"),
  };
});

assert("canPlace Y-orientation at [0,0,0] succeeds", canPlaceResults.canPlaceY);
assert("canPlace X-orientation at [0,0,0] succeeds", canPlaceResults.canPlaceX);
assert("canPlace X-orientation at [1,0,0] fails (blocked by connector at [3,0,0])", !canPlaceResults.cannotPlaceXBlocked);

// Clean up
await page.evaluate(() => (window as any).__assembly.clear());
await new Promise((r) => setTimeout(r, 200));

// ──────────────────────────────────────────────
// Test: Snap point discovery
// ──────────────────────────────────────────────
console.log("\n--- Test: Snap point discovery ---");

const snapResults = await page.evaluate(() => {
  const a = (window as any).__assembly;
  const snap = (window as any).__snap;
  a.clear();

  // Place a 3d6w connector at [5,0,5] — has sockets in all 6 directions
  a.addPart("connector-3d6w", [5, 0, 5]);

  // Find snap points for a support-3u near the connector
  const points = snap.findSnapPoints(a, "support-3u", [5, 0, 5], 5);

  // Should have snap candidates in multiple directions
  const orientations = points.map((p: any) => p.orientation);
  const directions = points.map((p: any) => p.socketDirection);

  return {
    count: points.length,
    orientations: [...new Set(orientations)],
    directions: [...new Set(directions)],
    // Check a specific snap: +y socket should produce Y-oriented support at [5,1,5]
    hasYSnap: points.some(
      (p: any) => p.orientation === "y" && p.socketDirection === "+y"
    ),
    // +x socket should produce X-oriented support
    hasXSnap: points.some(
      (p: any) => p.orientation === "x" && p.socketDirection === "+x"
    ),
  };
});

assert("Snap finds candidates near connector", snapResults.count > 0, `found ${snapResults.count}`);
assert("Snap includes Y-oriented candidate (+y socket)", snapResults.hasYSnap);
assert("Snap includes X-oriented candidate (+x socket)", snapResults.hasXSnap);
assert(
  "Snap has multiple orientations",
  snapResults.orientations.length >= 2,
  `orientations: ${JSON.stringify(snapResults.orientations)}`
);

// Test findBestSnap returns the nearest one
const bestSnapResult = await page.evaluate(() => {
  const a = (window as any).__assembly;
  const snap = (window as any).__snap;

  // Cursor near the +x socket of the connector at [5,0,5]
  const best = snap.findBestSnap(a, "support-3u", [6, 0, 5], 3);
  return best
    ? { position: best.position, orientation: best.orientation, direction: best.socketDirection }
    : null;
});

assert("findBestSnap returns a result near [6,0,5]", bestSnapResult !== null);
if (bestSnapResult) {
  assert(
    "Best snap is X-oriented (nearest to cursor at [6,0,5])",
    bestSnapResult.orientation === "x",
    `got orientation: ${bestSnapResult.orientation}`
  );
}

// Clean up
await page.evaluate(() => (window as any).__assembly.clear());
await new Promise((r) => setTimeout(r, 200));

// ──────────────────────────────────────────────
// Test: Snap does not propose occupied positions
// ──────────────────────────────────────────────
console.log("\n--- Test: Snap avoids occupied positions ---");

const snapOccupied = await page.evaluate(() => {
  const a = (window as any).__assembly;
  const snap = (window as any).__snap;
  a.clear();

  // Place connector and a support that blocks the +x direction
  a.addPart("connector-3d6w", [5, 0, 5]);
  a.addPart("support-3u", [6, 0, 5], [0, 0, 90], "x"); // Occupies [6,0,5],[7,0,5],[8,0,5]

  // Now find snap points — +x socket should be excluded (blocked)
  const points = snap.findSnapPoints(a, "support-3u", [6, 0, 5], 5);
  const hasXSnap = points.some((p: any) => p.socketDirection === "+x");

  return { hasXSnap, count: points.length };
});

assert("Snap excludes +x socket (blocked by existing support)", !snapOccupied.hasXSnap);
assert("Snap still finds other candidates", snapOccupied.count > 0);

// Clean up
await page.evaluate(() => (window as any).__assembly.clear());
await new Promise((r) => setTimeout(r, 200));

// ──────────────────────────────────────────────
// Test: BOM lock pins with oriented supports
// ──────────────────────────────────────────────
console.log("\n--- Test: BOM lock pins with oriented supports ---");

await page.evaluate(() => {
  const a = (window as any).__assembly;
  a.clear();
  // Connector at origin
  a.addPart("connector-3d6w", [0, 0, 0]);
  // Support along +x axis: origin at [1,0,0], occupies [1,0,0],[2,0,0],[3,0,0]
  a.addPart("support-3u", [1, 0, 0], [0, 0, 90], "x");
});
await new Promise((r) => setTimeout(r, 500));

const bomOriented = await page.evaluate(() => {
  const rows = document.querySelectorAll(".bom-table tbody tr");
  return Array.from(rows).map((row) => ({
    name: row.querySelector("td:first-child")?.textContent?.trim() ?? "",
    qty: row.querySelector(".bom-qty")?.textContent?.trim() ?? "",
  }));
});

assert(
  "BOM includes lock pins for x-oriented support adjacent to connector",
  bomOriented.some((r) => r.name.includes("Lock Pin")),
  `BOM rows: ${JSON.stringify(bomOriented)}`
);

// Clean up
await page.evaluate(() => (window as any).__assembly.clear());
await new Promise((r) => setTimeout(r, 200));

// ──────────────────────────────────────────────
// Test: Orientation keyboard cycling hint
// ──────────────────────────────────────────────
console.log("\n--- Test: Orientation keyboard hint ---");

// Select a support
await page.evaluate(() => {
  const items = document.querySelectorAll(".catalog-item");
  for (const item of items) {
    if (item.querySelector(".catalog-item-name")?.textContent?.trim() === "Support (3u)") {
      (item as HTMLElement).click();
      return;
    }
  }
});
await new Promise((r) => setTimeout(r, 300));

const supportHint = await page.evaluate(() => {
  return document.querySelector(".viewport-hint")?.textContent?.trim() ?? "";
});
assert(
  "Support placement hint mentions orientation cycling",
  supportHint.includes("orientation"),
  `hint: ${supportHint}`
);

// Now switch to a connector and check the hint changes
await page.evaluate(() => {
  const items = document.querySelectorAll(".catalog-item");
  for (const item of items) {
    if (item.querySelector(".catalog-item-name")?.textContent?.trim() === "3D 6-Way") {
      (item as HTMLElement).click();
      return;
    }
  }
});
await new Promise((r) => setTimeout(r, 300));

const connectorHint = await page.evaluate(() => {
  return document.querySelector(".viewport-hint")?.textContent?.trim() ?? "";
});
assert(
  "Connector placement hint mentions rotate (not orientation)",
  connectorHint.includes("rotate") && !connectorHint.includes("orientation"),
  `hint: ${connectorHint}`
);

// Exit placement mode
await page.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 200));

// Clean up for remaining tests
await page.evaluate(() => (window as any).__assembly.clear());
await new Promise((r) => setTimeout(r, 200));

// ──────────────────────────────────────────────
// Test 11: No unexpected page errors
// ──────────────────────────────────────────────
console.log("\n--- Test: No page errors ---");
assert("No unexpected page errors", pageErrors.length === 0, pageErrors.join("; "));

// ──────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────
await browser.close();
server.stop();

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) {
  console.log("\nFailed tests:");
  for (const r of results.filter((r) => !r.pass)) {
    console.log(`  - ${r.name}${r.detail ? `: ${r.detail}` : ""}`);
  }
}
console.log(`${"=".repeat(40)}`);

process.exit(exitCode);
