const { chromium } = require("@playwright/test");
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  await p.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await p.click("aside >> text=Reviewer");
  await p.waitForTimeout(1500);
  console.log(
    await p.evaluate(() => {
      const out = {};
      for (const sel of [
        "[data-session]",
        "[data-msg]",
        "[data-ask]",
        "[data-question]",
      ]) {
        const els = [...document.querySelectorAll(sel)];
        out[sel] = els.map((e) => e.getAttribute(sel.slice(1, -1)));
      }
      return JSON.stringify(out);
    }),
  );
  await b.close();
})();
