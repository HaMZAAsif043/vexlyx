// Run after: python -m tests.test_mail_credential_protocols --keep
// Requires Playwright and its Chromium browser (or VEXLYX_BROWSER_EXECUTABLE).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(
  process.env.VEXLYX_PLAYWRIGHT_MODULE || "playwright",
);

async function main() {
  const root = path.resolve(__dirname, "..");
  const state = JSON.parse(
    fs.readFileSync(
      path.join(root, "docker/mail-data/credential-browser-test.json"),
      "utf8",
    ),
  );
  const url = new URL(state.webmail_url);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.VEXLYX_BROWSER_EXECUTABLE || undefined,
  });
  try {
    const page = await browser.newPage();
    await page.goto(url.href);
    if (process.argv.includes("--inspect")) {
      console.log(await page.title());
      console.log(
        JSON.stringify(
          await page.locator("form").evaluateAll((forms) =>
            forms.map((form) => ({
              action: form.action,
              inputs: Array.from(form.querySelectorAll("input")).map(
                (input) => ({
                  name: input.name,
                  type: input.type,
                  id: input.id,
                }),
              ),
              buttons: Array.from(form.querySelectorAll("button")).map(
                (button) => button.innerText,
              ),
            })),
          ),
          null,
          2,
        ),
      );
      return;
    }
    await page.close();
    for (const address of [
      "test@vexlyx.local",
      "admin@vexlyx.local",
      "customer@credential-test.example",
    ]) {
      const context = await browser.newContext();
      const loginPage = await context.newPage();
      try {
        loginPage.setDefaultTimeout(30000);
        await loginPage.goto(url.href);
        await loginPage.locator("#rcmloginuser").fill(address);
        await loginPage
          .locator("#rcmloginpwd")
          .fill(
            address === "customer@credential-test.example"
              ? "private-test-password"
              : "vexlyx-dev",
          );
        await loginPage.getByRole("button", { name: /login/i }).click();
        // Failed logins can update the page without a navigation event.
        await loginPage.waitForFunction(
          () =>
            /Login failed/i.test(document.body.innerText) ||
            new URL(location.href).searchParams.get("_task") === "mail",
        );
        if (address === "customer@credential-test.example") {
          assert.equal(
            new URL(loginPage.url()).searchParams.get("_task"),
            "mail",
          );
          assert.equal(await loginPage.locator("#rcmloginuser").count(), 0);
          assert.match(await loginPage.locator("body").innerText(), /Inbox/i);
          await loginPage.reload();
          assert.equal(
            new URL(loginPage.url()).searchParams.get("_task"),
            "mail",
          );
          await loginPage.screenshot({
            path: path.join(
              root,
              "docker/mail-data/credential-browser-success.png",
            ),
          });
          console.log(
            "PASS: legitimate mailbox reaches Inbox and keeps its webmail session",
          );
        } else {
          await loginPage
            .locator("#rcmloginuser")
            .waitFor({ state: "visible" });
          assert.match(
            await loginPage.locator("body").innerText(),
            /Login failed/i,
          );
          console.log(
            `PASS: Roundcube rejects exposed credentials for ${address}`,
          );
        }
      } catch (error) {
        await loginPage.screenshot({
          path: path.join(
            root,
            "docker/mail-data/credential-browser-failure.png",
          ),
        });
        console.error(await loginPage.locator("body").innerText());
        throw error;
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
