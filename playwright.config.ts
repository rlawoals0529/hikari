import { defineConfig, devices } from "@playwright/test";

/**
 * The widgets, in a real browser.
 *
 * Everything else here is checked by `node --test`, which is enough for the code that decides
 * what a widget says. It cannot see what a widget LOOKS like, and the thing most worth
 * checking about these is a property of the rendered page: they float over a wallpaper nobody
 * chose, so whether their text can be read depends on compositing a translucent panel against
 * a background this repo does not own.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:8911", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Static files straight off disk: these widgets are plain HTML and there is nothing to
    // build. The host binds explicitly because "localhost" resolves to ::1 on some machines
    // and the health check then waits out its timeout against a server listening elsewhere.
    command: "npx --yes http-server -p 8911 -a 127.0.0.1 -s .",
    url: "http://127.0.0.1:8911/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
