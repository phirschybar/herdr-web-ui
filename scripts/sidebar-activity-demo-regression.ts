import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";

// Settings → Sidebar order (Activity) and Mark unseen finishes, on the unmodified app over the
// demo's fixture transport, whose agents carry herdr's state_change_seq and bump it on every state
// change. The demo's Claude pane finishes by itself 4.5s in (site/demo/transport.ts), and a message
// sent from a chat runs for 2.4s and then finishes. All files and HTTP traffic stay in this
// disposable, loopback-only app; no herdr session is opened.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-activity-demo-"));

const API = "Idempotent payments";        // claude, working, finishes by itself
const WEB = "Guard the export button";    // codex, blocked
const INFRA = "Why did the backup fail?"; // idle: the pane a message is sent from
const SHELL = "Tag v1.4.0";               // no agent, no state_change_seq

const rows = (page: Page) => page.locator(".machine-workspaces .workspace.pane-item");
const titles = (page: Page) => rows(page).locator(".pane-title").allTextContents();
const row = (page: Page, title: string) => rows(page).filter({ has: page.locator(".pane-title", { hasText: title }) });
const unseen = async (page: Page, title: string) => (await row(page, title).locator(".unseen-dot").count()) === 1;
const badge = (page: Page, title: string) => row(page, title).locator(".pane-meta .badge");
const open = (page: Page, title: string) => row(page, title).locator(".pane-select").click();

async function withPage(browser: Browser, settings: object, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await context.addInitScript((stored) => {
      if (!sessionStorage.getItem("settings-set")) {
        localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", ...stored }));
        sessionStorage.setItem("settings-set", "1");
      }
    }, settings);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // the shell pane is on screen, so the demo's own finish happens out of sight
    await page.goto(`${url}?pane=${encodeURIComponent(panes.shell)}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await rows(page).first().waitFor();
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

let url = "";
try {
  const build = Bun.spawnSync([join(repo, "node_modules/.bin/vite"), "build", "--base", "./", "--outDir", app, "--emptyOutDir", "--logLevel", "warn"], { cwd: repo });
  assert.equal(build.exitCode, 0, new TextDecoder().decode(build.stderr));
  const transport = await Bun.build({
    entrypoints: [join(repo, "site/demo/transport.ts")], outdir: app,
    naming: "demo-transport.js", target: "browser",
    define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version) },
  });
  assert.ok(transport.success, transport.logs.map(String).join("\n"));
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;

  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      // Default: herdr's order with its reorder grips, and no marks, before and after a finish
      await withPage(browser, {}, async (page) => {
        const before = await titles(page);
        assert.deepEqual(before.slice(0, 2), [API, WEB], `herdr's order: ${before}`);
        assert.equal(await rows(page).locator(".sidebar-drag-handle").count(), before.length, "every row keeps its grip");
        await badge(page, API).filter({ hasText: "DONE" }).waitFor({ timeout: 10_000 });
        assert.deepEqual(await titles(page), before, "a finish does not move a row");
        assert.equal(await page.locator(".unseen-dot").count(), 0, "no marks unless they are turned on");
      });
      console.log("PASS by default the sidebar keeps herdr's order and its grips, and marks nothing");

      await withPage(browser, { sidebarOrder: "activity", unseenMarks: true }, async (page) => {
        assert.equal((await titles(page))[0], WEB, "the blocked workspace is pinned on top");
        assert.equal(await rows(page).locator(".sidebar-drag-handle").count(), 0, "Activity sets the order itself: no grips");
        assert.equal(await page.locator(".unseen-dot").count(), 0, "turning marks on counts everything open as seen");

        // the demo's Claude pane finishes out of sight: it rises under the blocked one, marked
        await badge(page, API).filter({ hasText: "DONE" }).waitFor({ timeout: 10_000 });
        await page.waitForFunction((title) => [...document.querySelectorAll(".machine-workspaces .workspace.pane-item .pane-title")][1]?.textContent === title, API);
        await row(page, API).locator(".unseen-dot").waitFor({ timeout: 5_000 });
        assert.equal(await row(page, SHELL).locator(".unseen-dot").count(), 0);

        // a message sent from a pane takes it to the top while it runs ...
        await open(page, INFRA);
        await page.locator(".composer-text").fill("Check the backup again");
        await page.locator(".composer-text").press("Enter");
        await badge(page, INFRA).filter({ hasText: "RUN" }).waitFor();
        await page.waitForFunction((title) => [...document.querySelectorAll(".machine-workspaces .workspace.pane-item .pane-title")][1]?.textContent === title, INFRA);
        // ... and keeps it there when it finishes while another pane is open, marked
        await open(page, SHELL);
        await badge(page, INFRA).filter({ hasText: "DONE" }).waitFor({ timeout: 10_000 });
        assert.equal((await titles(page))[1], INFRA, "the row just worked in stays on top after it finishes");
        // the mark follows the pushed status (lib/sidebarOrder.ts liveSeqs), not the next roster read
        await row(page, INFRA).locator(".unseen-dot").waitFor({ timeout: 5_000 });

        // opening it clears the mark and quiets its DONE; the record is kept per PC on this browser
        // (a reload would reset the demo itself, whose state lives in the page)
        await open(page, INFRA);
        await page.waitForFunction((title) => ![...document.querySelectorAll(".machine-workspaces .workspace.pane-item")].some((item) => item.querySelector(".pane-title")?.textContent === title && item.querySelector(".unseen-dot")), INFRA);
        assert.match(await badge(page, INFRA).getAttribute("class") ?? "", /\bis-seen\b/);
        const record = JSON.parse(await page.evaluate(() => localStorage.getItem("herdr-web-ui:seen:local") ?? "{}")) as Record<string, number>;
        assert.ok(record[panes.infra]! > record[panes.api]!, `the opened finish is recorded past the unopened one: ${JSON.stringify(record)}`);
        assert.ok(await unseen(page, API), "an unopened finish stays marked");
      });
      console.log("PASS Activity pins blocked and follows recency; a finish out of sight is marked until it is opened");
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
