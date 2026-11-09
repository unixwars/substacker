import { expect, test } from "@playwright/test";

test.describe("installability", () => {
  test("the manifest takes its name from the configuration and lists working icons", async ({ page, request }) => {
    for (const [site, name, short] of [["main", "Example Newsletter", "Example"], ["bare", "Bare Example Reader Weekly", "Bare"]] as const) {
      await page.goto(`/${site}/`);
      const href = await page.locator('link[rel="manifest"]').getAttribute("href");
      const manifest = await (await request.get(new URL(href ?? "", page.url()).toString())).json();
      expect(manifest).toMatchObject({ name, short_name: short, display: "standalone" });
      const purposes = manifest.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}:${i.purpose}`);
      expect(purposes).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
      for (const icon of manifest.icons) {
        const res = await request.get(new URL(icon.src, page.url()).toString());
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toBe(icon.type);
      }
    }
  });

  test("the page links its icons and the Apple touch icon", async ({ page, request }) => {
    await page.goto("/main/");
    for (const sel of ['link[rel="icon"][type="image/svg+xml"]', 'link[rel="apple-touch-icon"]']) {
      const href = await page.locator(sel).getAttribute("href");
      expect((await request.get(new URL(href ?? "", page.url()).toString())).status()).toBe(200);
    }
    expect(await page.locator('meta[name="theme-color"]').getAttribute("content")).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("the service worker precaches the manifest and every icon", async ({ page }) => {
    await page.goto("/main/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect
      .poll(async () => {
        const names = await page.evaluate(() => caches.keys());
        const urls: string[] = [];
        for (const n of names.filter((x) => x.startsWith("substacker:/main/:"))) {
          urls.push(...(await page.evaluate(async (c) => (await (await caches.open(c)).keys()).map((r) => r.url), n)));
        }
        return ["manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png", "icon.svg"].filter(
          (f) => !urls.some((u) => u.endsWith(`/${f}`)),
        );
      })
      .toEqual([]);
  });
});
