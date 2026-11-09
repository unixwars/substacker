import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

// Wait until the worker controls the page, then reload so that every request goes through it.
async function installAndControl(page: Page, path: string) {
  await page.goto(path);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await page.reload();
  await expect(page.locator(".entry").first()).toBeVisible();
}

const cachedKeys = (page: Page, name: string) =>
  page.evaluate(async (n) => (await (await caches.open(n)).keys()).map((r) => r.url), name);

test.describe("offline", () => {
  test("a post opened online still opens after going offline, and an unopened one says so", async ({ page, context }) => {
    await installAndControl(page, "/main/");
    await page.getByRole("link", { name: /Hello, world/ }).click();
    await expect(page.getByRole("heading", { name: "Hello, world" })).toBeVisible();
    await expect(page.locator("article [data-offline]")).toBeVisible();
    await expect(page.getByText("A placeholder caption.")).toBeVisible();

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Hello, world" })).toBeVisible();
    await expect(page.getByText("Welcome to the first placeholder post")).toBeVisible();
    const img = page.locator(".post-body img").first();
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    await page.evaluate(() => { window.location.hash = "#/p/second-post"; });
    await expect(page.getByText("This post is not available offline.")).toBeVisible();

    // The list works offline too, and marks what is available.
    await page.evaluate(() => { window.location.hash = "#/"; });
    await expect(page.locator(".entry")).toHaveCount(3);
    await expect(page.locator(".entry", { hasText: "Hello, world" }).locator("[data-offline]")).toBeVisible();
    await expect(page.locator(".entry", { hasText: "Second post" }).locator("[data-offline]")).toHaveCount(0);
  });

  test("with a low cap the oldest opened post is evicted", async ({ page }) => {
    await installAndControl(page, "/capped/");
    await page.getByRole("link", { name: /Hello, world/ }).click();
    await expect(page.locator("article [data-offline]")).toBeVisible();
    expect((await cachedKeys(page, "substacker:/capped/:content")).some((u) => u.endsWith("/posts/hello-world.json"))).toBe(true);

    await page.evaluate(() => { window.location.hash = "#/p/second-post"; });
    await expect(page.getByRole("heading", { name: "Second post" })).toBeVisible();
    await expect(page.locator("article [data-offline]")).toBeVisible();
    await expect
      .poll(async () => (await cachedKeys(page, "substacker:/capped/:content")).filter((u) => u.includes("/posts/")).map((u) => u.split("/").pop()))
      .toEqual(["second-post.json"]);
  });

  test("a second shell on the same origin keeps its caches", async ({ page }) => {
    await installAndControl(page, "/main/");
    await page.getByRole("link", { name: /Hello, world/ }).click();
    await expect(page.locator("article [data-offline]")).toBeVisible();

    await installAndControl(page, "/bare/");
    const names = await page.evaluate(() => caches.keys());
    expect(names.filter((n) => n.startsWith("substacker:/main/:")).length).toBeGreaterThan(0);
    expect(names.filter((n) => n.startsWith("substacker:/bare/:")).length).toBeGreaterThan(0);
    expect((await cachedKeys(page, "substacker:/main/:content")).some((u) => u.endsWith("/posts/hello-world.json"))).toBe(true);
  });
});

// The scenario from the review: a first visit with no reload after the worker takes control.
test.describe("first visit", () => {
  test("works offline after opening a post, without a reload having been needed", async ({ page, context }) => {
    await page.goto("/main/");
    await expect(page.locator(".entry").first()).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    await page.getByRole("link", { name: /Hello, world/ }).click();
    await expect(page.getByRole("heading", { name: "Hello, world" })).toBeVisible();
    await expect(page.locator("article [data-offline]")).toBeVisible();

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Hello, world" })).toBeVisible();
    await expect(page.getByText("Welcome to the first placeholder post")).toBeVisible();
    await page.evaluate(() => { window.location.hash = "#/"; });
    await expect(page.locator(".entry")).toHaveCount(3);
  });

  test("keeps config.json and the content index from install", async ({ page }) => {
    await page.goto("/main/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect
      .poll(async () => (await cachedKeys(page, "substacker:/main/:content")).map((u) => new URL(u).pathname).sort())
      .toEqual(["/main/config.json", "/main/content/index.json"]);
  });
});

test.describe("failures that must not break reading", () => {
  test("a server error on a post falls back to the copy kept from before", async ({ page, request }) => {
    await installAndControl(page, "/main/");
    await page.getByRole("link", { name: /Hello, world/ }).click();
    await expect(page.locator("article [data-offline]")).toBeVisible();
    await request.get("http://127.0.0.1:4173/__control/fail-posts/on");
    try {
      await page.reload();
      await expect(page.getByRole("heading", { name: "Hello, world" })).toBeVisible();
      await expect(page.getByText("Welcome to the first placeholder post")).toBeVisible();
      // A post never opened has no copy: the error is shown, not hidden.
      await page.evaluate(() => { window.location.hash = "#/p/second-post"; });
      await expect(page.getByRole("heading", { name: "Second post" })).toHaveCount(0);
    } finally {
      await request.get("http://127.0.0.1:4173/__control/fail-posts/off");
    }
  });

  test("a failing IndexedDB does not break an online post or image", async ({ page, context }) => {
    await installAndControl(page, "/main/");
    const [worker] = context.serviceWorkers();
    await worker?.evaluate(() => {
      indexedDB.open = () => { throw new Error("IndexedDB is unavailable"); };
    });
    await page.getByRole("link", { name: /Hello, world/ }).click();
    await expect(page.getByRole("heading", { name: "Hello, world" })).toBeVisible();
    await expect(page.getByText("Welcome to the first placeholder post")).toBeVisible();
    const img = page.locator(".post-body img").first();
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  });
});

// A site at the root of its origin: the worker's scope is "/", which includes pages that are not the shell's.
test.describe("a site at the root of its origin", () => {
  const ORIGIN = "http://127.0.0.1:4174";

  test("serves the shell only for the scope itself; other pages on the origin come from the network", async ({ page, context }) => {
    await page.goto(`${ORIGIN}/`);
    await expect(page.locator(".entry").first()).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    expect(new URL(await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)).pathname).toBe("/");

    await page.goto(`${ORIGIN}/elsewhere/`);
    await expect(page.getByRole("heading", { name: "Another app" })).toBeVisible();
    await expect(page.locator(".entry")).toHaveCount(0);

    // A path that does not exist is a 404 from the server, not the shell.
    const missing = await page.goto(`${ORIGIN}/no-such-page/`);
    expect(missing?.status()).toBe(404);

    // The shell itself still opens offline, at "/" and at "/index.html".
    await page.goto(`${ORIGIN}/`);
    await expect(page.locator(".entry").first()).toBeVisible();
    await context.setOffline(true);
    await page.goto(`${ORIGIN}/`);
    await expect(page.locator(".entry")).toHaveCount(3);
    await page.goto(`${ORIGIN}/index.html`);
    await expect(page.locator(".entry")).toHaveCount(3);
  });
});
