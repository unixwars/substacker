import { expect, test } from "@playwright/test";

test.describe("list", () => {
  test("shows the posts newest first", async ({ page }) => {
    await page.goto("/main/");
    // A retrying assertion: the list renders after config.json and the index load, so reading
    // the titles right after goto raced the render and sometimes saw an empty list.
    await expect(page.locator(".entry-title")).toHaveText(["Just text", "Second post", "Hello, world"]);
  });

  test("shows an empty state for a feed with no posts", async ({ page }) => {
    await page.goto("/empty/");
    await expect(page.getByText("No posts yet.")).toBeVisible();
    await expect(page.locator(".entry")).toHaveCount(0);
  });
});

test.describe("post", () => {
  test("opens a post with its text and a working image", async ({ page }) => {
    await page.goto("/main/");
    await page.getByRole("link", { name: /Hello, world/ }).click();
    await expect(page).toHaveURL(/#\/p\/hello-world$/);
    await expect(page.getByRole("heading", { name: "Hello, world" })).toBeVisible();
    await expect(page.getByText("Welcome to the first placeholder post")).toBeVisible();
    await expect(page.locator("figcaption")).toHaveText("A placeholder caption.");
    const img = page.locator(".post-body img").first();
    await expect(img).toHaveAttribute("src", /^http:\/\/127\.0\.0\.1:4173\/main\/content\/images\/[0-9a-f]{14}\./);
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  });

  test("leaves out the Substack call-to-action buttons", async ({ page }) => {
    await page.goto("/main/#/p/hello-world");
    await expect(page.getByRole("heading", { name: "Hello, world" })).toBeVisible();
    await expect(page.getByText("Subscribe now")).toHaveCount(0);
    await expect(page.getByText("Leave a comment")).toHaveCount(0);
  });

  test("moves between previous and next", async ({ page }) => {
    await page.goto("/main/#/p/second-post");
    await expect(page.getByRole("heading", { name: "Second post" })).toBeVisible();
    await page.getByRole("link", { name: /^Newer:/ }).click();
    await expect(page.getByRole("heading", { name: "Just text" })).toBeVisible();
    await expect(page.getByRole("link", { name: /^Newer:/ })).toHaveCount(0);
    await page.getByRole("link", { name: /^Older:/ }).click();
    await expect(page.getByRole("heading", { name: "Second post" })).toBeVisible();
    await page.getByRole("link", { name: /^Older:/ }).click();
    await expect(page.getByRole("heading", { name: "Hello, world" })).toBeVisible();
    await expect(page.getByRole("link", { name: /^Older:/ })).toHaveCount(0);
  });

  test("always links to the post on Substack with our utm values", async ({ page }) => {
    await page.goto("/bare/#/p/hello-world");
    const link = page.getByRole("link", { name: "Read on Substack" });
    await expect(link).toHaveAttribute("href", "https://example.substack.com/p/hello-world?utm_source=substacker&utm_medium=reader");
  });

  test("says a slug is not found when it is hidden or unknown", async ({ page }) => {
    await page.goto("/bare/#/p/second-post");
    await expect(page.getByText("Post not found.")).toBeVisible();
    await page.goto("/main/#/p/no-such-post");
    await expect(page.getByText("Post not found.")).toBeVisible();
  });
});

test.describe("search", () => {
  test("finds a post by its text", async ({ page }) => {
    await page.goto("/main/");
    await page.getByRole("searchbox", { name: "Search posts" }).fill("lorem");
    await expect(page.locator(".entry-title")).toHaveText(["Hello, world"]);
  });

  test("says when nothing matches", async ({ page }) => {
    await page.goto("/main/#/?q=zzzzqqqq");
    await expect(page.getByText("No posts match.")).toBeVisible();
  });

  test("does not find a hidden post", async ({ page }) => {
    await page.goto("/bare/#/?q=shorter");
    await expect(page.getByText("No posts match.")).toBeVisible();
    await page.goto("/bare/");
    await expect(page.locator(".entry-title")).toHaveText(["Just text", "Hello, world"]);
  });
});

test.describe("configuration", () => {
  test("shows the dock and the subscribe link when configured", async ({ page }) => {
    await page.goto("/main/#/p/hello-world");
    const dock = page.getByRole("navigation", { name: "Post actions" });
    await expect(dock.getByRole("link", { name: "Comments" })).toHaveAttribute(
      "href",
      "https://example.substack.com/p/hello-world/comments?utm_source=substacker&utm_medium=reader",
    );
    await expect(dock.getByRole("link", { name: "Share" })).toHaveAttribute(
      "href",
      "https://example.substack.com/p/hello-world?utm_source=substacker&utm_medium=reader&action=share",
    );
    await expect(page.getByRole("link", { name: "Subscribe" })).toHaveAttribute(
      "href",
      "https://example.substack.com/subscribe?utm_source=substacker&utm_medium=reader",
    );
  });

  test("shows neither when not configured", async ({ page }) => {
    await page.goto("/bare/#/p/hello-world");
    await expect(page.getByRole("heading", { name: "Hello, world" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Post actions" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Subscribe" })).toHaveCount(0);
  });
});
