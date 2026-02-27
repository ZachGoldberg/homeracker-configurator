/// Take a screenshot of the configurator page

import { join } from "path";
import puppeteer from "puppeteer";

const PROJECT_ROOT = join(import.meta.dir, "..");
const DIST_DIR = join(PROJECT_ROOT, "dist");
const PUBLIC_DIR = join(PROJECT_ROOT, "public");

// Build
console.log("Building...");
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

// Serve
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = url.pathname;

    if (pathname.startsWith("/src/")) {
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
console.log(`Server on ${baseUrl}`);

// Screenshot
const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--enable-webgl", "--use-gl=angle", "--use-angle=swiftshader"],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

page.on("console", (msg) => {
  if (msg.type() === "error") console.error("[ERR]", msg.text());
});
page.on("pageerror", (err) => console.error("[PAGE ERR]", err.message));

await page.goto(baseUrl, { waitUntil: "networkidle0", timeout: 15000 });
await new Promise((r) => setTimeout(r, 2000));

const screenshotPath = join(PROJECT_ROOT, "screenshot.png");
await page.screenshot({ path: screenshotPath, fullPage: false });
console.log(`Screenshot saved to ${screenshotPath}`);

// Also dump computed styles of key elements
const layoutInfo = await page.evaluate(() => {
  const getRect = (sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      selector: sel,
      x: r.x, y: r.y, width: r.width, height: r.height,
      display: cs.display, flexDirection: cs.flexDirection,
      overflow: cs.overflow, position: cs.position,
    };
  };
  return {
    app: getRect(".app"),
    sidebar: getRect(".sidebar"),
    mainArea: getRect(".main-area"),
    toolbar: getRect(".toolbar"),
    viewport: getRect(".viewport"),
    canvas: getRect(".viewport canvas"),
    bom: getRect(".bom-panel"),
    body: getRect("body"),
    root: getRect("#root"),
  };
});

console.log("\n=== Layout Info ===");
for (const [key, val] of Object.entries(layoutInfo)) {
  if (val) {
    console.log(`${key}: ${val.width}x${val.height} at (${val.x},${val.y}) display=${val.display} flex=${val.flexDirection}`);
  } else {
    console.log(`${key}: NOT FOUND`);
  }
}

await browser.close();
server.stop();
