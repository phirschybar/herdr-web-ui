import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";

// Deep links (lib/deepLink.ts) on the unmodified app over the demo's fixture transport: an
// address names the PC, workspace, pane, lens and Settings page, opens there, and follows the app
// as it moves; Back and Forward walk the panes. All files and HTTP traffic stay in this
// disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-deep-link-demo-"));
const INFRA = panes.infra;
const DOCS = panes.docs;
const wsOf = (pane: string) => pane.split(":")[0]!;

const query = (page: Page) => page.evaluate(() => Object.fromEntries(new URLSearchParams(window.location.search)));
const selected = (page: Page) => page.locator('.agents-sidebar .agent-select[aria-current="true"]').evaluate((node) => node.closest(".agent-item")?.getAttribute("data-pane"));
const waitSelected = (page: Page, pane: string) => page.waitForFunction((id) => document.querySelector('.agents-sidebar .agent-select[aria-current="true"]')?.closest(".agent-item")?.getAttribute("data-pane") === id, pane, { timeout: 10_000 });
const waitQuery = (page: Page, name: string, value: string | null) => page.waitForFunction(([key, want]) => new URLSearchParams(window.location.search).get(key) === want, [name, value] as const, { timeout: 10_000 });

async function withPage(browser: Browser, search: string, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-US" });
  try {
    await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}${search}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await page.locator(".agents-sidebar .agent-item").first().waitFor();
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

let url = "";
try {
  await buildDemoApp(app);
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
      // a link to a workspace opens the pane its row opens, and the address then names it all
      await withPage(browser, `?ws=${wsOf(INFRA)}`, async (page) => {
        await waitSelected(page, INFRA);
        await waitQuery(page, "pane", INFRA);
        const named = await query(page);
        assert.equal(named["ws"], wsOf(INFRA));
        assert.ok(named["view"] === "chat" || named["view"] === "terminal", JSON.stringify(named));
        assert.equal(named["machine"], undefined, "the local PC is not written");
      });
      // a pane that has closed falls back to the pane its workspace's row opens
      await withPage(browser, `?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(`${wsOf(INFRA)}:p99`)}&view=terminal`, async (page) => {
        await waitSelected(page, INFRA);
        await waitQuery(page, "pane", INFRA);
      });
      console.log("PASS a link to a workspace, or to a pane of it that has closed, opens the pane its row opens");

      // moving between panes is history; the lens is not; Back and Forward walk it
      await withPage(browser, `?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}&view=chat`, async (page) => {
        await waitSelected(page, INFRA);
        assert.equal(await page.locator('.view-switch button[aria-pressed="true"]').innerText(), "Chat", "the linked lens is the one shown");
        const start = await page.evaluate(() => history.length);
        await page.locator(`.agents-sidebar .agent-item[data-pane="${DOCS}"] .agent-select`).click();
        await waitQuery(page, "pane", DOCS);
        assert.equal(await page.evaluate(() => history.length), start + 1, "opening another pane is an entry");
        await page.locator(".view-switch button", { hasText: "Terminal" }).click();
        await waitQuery(page, "view", "terminal");
        assert.equal(await page.evaluate(() => history.length), start + 1, "a lens switch replaces the entry");
        await page.goBack();
        await waitSelected(page, INFRA);
        assert.equal((await query(page))["view"], "chat", "Back returns to the pane in the lens it was left in");
        await page.goForward();
        await waitSelected(page, DOCS);
        await waitQuery(page, "view", "terminal");
        assert.equal(await selected(page), DOCS);
      });
      console.log("PASS opening another pane is a history entry and a lens switch is not; Back and Forward return to each pane in its lens");

      // a link to a Settings page opens it there; the address follows its pages and drops it on close
      await withPage(browser, `?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}&settings=terminal`, async (page) => {
        const dialog = page.getByRole("dialog", { name: "Settings" });
        await dialog.waitFor();
        await dialog.getByRole("tabpanel", { name: "Terminal", exact: true }).waitFor();
        await waitQuery(page, "settings", "terminal");
        await dialog.getByRole("tab", { name: "Chat", exact: true }).click();
        await waitQuery(page, "settings", "chat");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        await waitQuery(page, "settings", null);
        await waitQuery(page, "pane", INFRA);
      });
      console.log("PASS a link to a Settings page opens it there, the address follows its pages, and closing it leaves the pane's address");
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
