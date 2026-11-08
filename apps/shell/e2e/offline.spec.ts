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
