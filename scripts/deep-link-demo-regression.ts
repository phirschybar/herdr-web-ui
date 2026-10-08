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
        assert.equal(named["ws"], `${wsOf(INFRA)}-infra`, "ws names the workspace by id and slug");
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

      // ws carries the workspace's name as a slug; a slug another workspace has wins over a reused id
      const note = (page: Page) => page.locator(".header-note").textContent();
      await withPage(browser, `?ws=${wsOf(INFRA)}`, async (page) => {
        await waitQuery(page, "ws", `${wsOf(INFRA)}-infra`);
      });
      await withPage(browser, `?ws=${wsOf(panes.api)}-infra&pane=${encodeURIComponent(panes.api)}`, async (page) => {
        await waitSelected(page, INFRA);
        await waitQuery(page, "ws", `${wsOf(INFRA)}-infra`);
        assert.equal(await note(page), "That agent has closed: its workspace is open");
      });
      await withPage(browser, `?ws=w9z-gone&pane=${encodeURIComponent("w9z:p1")}`, async (page) => {
        await page.locator(".header-note").waitFor();
        assert.equal(await note(page), "That link's workspace is closed");
      });
      console.log("PASS ws carries the workspace's slug; a slug that names another workspace wins over the id, and a link to nothing open says so");

      // a link to a Settings group scrolls to it and focuses it; another page drops it from the address
      await withPage(browser, `?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}&settings=chat&section=quick-replies`, async (page) => {
        const dialog = page.getByRole("dialog", { name: "Settings" });
        await dialog.waitFor();
        await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset["section"] === "quick-replies");
        await waitQuery(page, "section", "quick-replies");
        await dialog.getByRole("tab", { name: "Appearance", exact: true }).click();
        await waitQuery(page, "settings", "appearance");
        await waitQuery(page, "section", null);
      });
      await withPage(browser, `?settings=about&section=updates`, async (page) => {
        await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset["section"] === "updates");
      });
      console.log("PASS a link to a Settings group scrolls to and focuses it, and another page drops it from the address");

      // a link to a file opens it over its pane; closing the viewer takes it off the address
      await withPage(browser, `?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}&file=README.md`, async (page) => {
        await page.locator(".modal.file-viewer").waitFor();
        await waitQuery(page, "file", "README.md");
        await page.keyboard.press("Escape");
        await page.locator(".modal.file-viewer").waitFor({ state: "detached" });
        await waitQuery(page, "file", null);
        await waitQuery(page, "pane", INFRA);
      });
      // a reload restores the viewer from its own entry; Back then closes it for good
      await withPage(browser, `?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}&file=README.md`, async (page) => {
        await page.locator(".modal.file-viewer").waitFor();
        await page.reload();
        await page.locator(".modal.file-viewer").waitFor();
        await page.goBack();
        await page.locator(".modal.file-viewer").waitFor({ state: "detached" });
        for (const deadline = Date.now() + 1_500; Date.now() < deadline;) {
          assert.equal(await page.locator(".modal.file-viewer").count(), 0, "the linked file does not open again after Back closed it");
          await page.waitForTimeout(100);
        }
      });
      console.log("PASS a link to a file opens it over its pane, and closing the viewer takes it off the address");

      // Copy link puts the address on the clipboard and says so
      await withPage(browser, `?ws=${wsOf(DOCS)}&pane=${encodeURIComponent(DOCS)}`, async (page) => {
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await waitQuery(page, "pane", DOCS);
        await page.locator(".header-more-button").click();
        await page.getByRole("menuitem", { name: "Copy link" }).click();
        await page.locator(".header-note", { hasText: "Link copied" }).waitFor();
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), page.url());
      });
      console.log("PASS Copy link puts the address on the clipboard");

      // a link to the New workspace dialog fills its fields and creates nothing by itself; the
      // address follows what is typed, and closing the dialog takes it off
      await withPage(browser, `?new=workspace&cwd=${encodeURIComponent("/home/demo/infra")}&name=Fix%20backup&agent=codex`, async (page) => {
        const dialog = page.getByRole("dialog", { name: /New workspace/ });
        await dialog.waitFor();
        assert.equal(await page.locator("#new-session-cwd").inputValue(), "/home/demo/infra");
        assert.equal(await dialog.getByRole("textbox", { name: "Name" }).inputValue(), "Fix backup");
        await dialog.locator(".agent-picker-label", { hasText: /codex/i }).waitFor();
        const workspaces = async () => (await page.evaluate(async () => (await (await fetch("/api/session")).json()).snapshot.workspaces.length)) as number;
        const before = await workspaces();
        await page.waitForTimeout(800);
        assert.equal(await workspaces(), before, "a link fills the form; Create is still the user's");
        await waitQuery(page, "name", "Fix backup");
        await dialog.getByRole("textbox", { name: "Name" }).fill("Fix the nightly backup");
        await waitQuery(page, "name", "Fix the nightly backup");
        assert.equal((await query(page))["new"], "workspace");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        await waitQuery(page, "new", null);
        await waitQuery(page, "name", null);
      });
      // an agent herdr does not offer is left out, and a tab link opens the dialog for the linked workspace
      await withPage(browser, `?ws=${wsOf(INFRA)}-infra&new=tab&agent=nope`, async (page) => {
        const dialog = page.getByRole("dialog", { name: /New tab · infra/ });
        await dialog.waitFor();
        await waitQuery(page, "new", "tab");
        // the dialog drops it once herdr's agents are in, and the address follows a moment later
        await page.waitForFunction(() => new URLSearchParams(window.location.search).get("agent") !== "nope", undefined, { timeout: 5_000 });
      });
      console.log("PASS a link to the New workspace dialog fills it and creates nothing; the address follows the fields, and a tab link opens it for its workspace");
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
