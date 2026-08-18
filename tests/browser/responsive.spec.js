const { test, expect } = require("@playwright/test");

const viewports = [
  { name: "mobile 390x844", width: 390, height: 844 },
  { name: "tablet 768x1024", width: 768, height: 1024 },
  { name: "desktop 1440x900", width: 1440, height: 900 }
];

async function expectNoPageOverflow(page, context) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth
  }));
  expect(dimensions.document, `${context}: document overflow`).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.body, `${context}: body overflow`).toBeLessThanOrEqual(dimensions.viewport);
}

async function expectVisibleControlsContained(page, context) {
  const failures = await page.locator("button:visible, input:visible, select:visible, textarea:visible").evaluateAll((elements) => elements.flatMap((element) => {
    if (element.closest(".admin-sidebar nav")) return [];
    const box = element.getBoundingClientRect();
    const outside = box.left < -1 || box.right > window.innerWidth + 1;
    return outside ? [{ text: (element.textContent || element.getAttribute("name") || element.tagName).trim().slice(0, 60), left: box.left, right: box.right }] : [];
  }));
  expect(failures, `${context}: controls outside viewport`).toEqual([]);
}

async function openPatientMenu(page) {
  await page.goto("/");
  const languageChoice = page.locator('[data-action="set_lang_en"]');
  if (await languageChoice.isVisible()) await languageChoice.click();
  await expect(page.locator('[data-action="start_booking"]')).toBeVisible();
}

for (const viewport of viewports) {
  test(`public portal has no clipping at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPatientMenu(page);
    await expectNoPageOverflow(page, viewport.name);
    await expectVisibleControlsContained(page, viewport.name);
  });

  test(`staff login and dashboard are usable at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/admin/login");
    await page.locator('input[name="email"]').fill("qa.admin@clinic.test");
    await page.locator('input[name="password"]').fill("QaBrowser!Pass2026");
    await page.locator("#login-submit-btn").click();
    await expect(page.locator("#admin-main-content h2")).toContainText("Overview", { timeout: 20_000 });
    await expectNoPageOverflow(page, `staff ${viewport.name}`);
    await expectVisibleControlsContained(page, `staff ${viewport.name}`);
    await expect(page.locator(".admin-sidebar nav")).toBeVisible();
    const lastMenuItem = page.locator(".admin-sidebar nav button").last();
    await lastMenuItem.scrollIntoViewIfNeeded();
    await expect(lastMenuItem).toBeInViewport();
  });
}

test("mobile patient completes the real website booking flow with active consent", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPatientMenu(page);
  await page.locator('[data-action="start_booking"]').click();
  await page.locator("#chat-input").fill("Synthetic Browser Patient");
  await page.locator("#chat-composer").press("Enter");
  await page.locator("#chat-input").fill("03005550191");
  await page.locator("#chat-composer").press("Enter");
  await page.locator('[data-action="booking_type_in_person"]').click();
  await page.locator('[data-action="booking_city_bwp"]').click();
  await page.locator('[data-action^="booking_date_"]').first().click();
  await page.locator('[data-action^="booking_time_"]').first().click();
  await expect(page.locator('[data-action="confirm_booking_final"]')).toBeVisible();
  await page.locator('[data-action="confirm_booking_final"]').click();
  await expect(page.locator("#chat-body")).toContainText("booked successfully", { timeout: 20_000 });
  await expect(page.locator("#chat-body")).toContainText(/Token:\s*\d+/);
  await expectNoPageOverflow(page, "completed mobile booking");
  await expectVisibleControlsContained(page, "completed mobile booking");
});
