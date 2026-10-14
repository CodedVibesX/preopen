// Capture the card to docs/ with the system Chrome, and fail on two things a reviewer would catch: horizontal overflow
// on a phone, and any dash in the visible text. Needs a server on http://localhost:3007 (npm run dev).
//   node scripts/shoot.mjs [url]
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL_ = process.argv[2] ?? "http://localhost:3007";
mkdirSync("docs", { recursive: true });

const b = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--force-color-profile=srgb", "--hide-scrollbars"] });
const problems = [];
try {
  const p = await b.newPage();
  const errors = [];
  p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  p.on("pageerror", (e) => errors.push(String(e)));

  await p.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  await p.goto(URL_, { waitUntil: "networkidle0" });
  // mid walk, then the finished walk
  await new Promise((r) => setTimeout(r, 3600));
  await (await p.$(".hero")).screenshot({ path: "docs/hero_midwalk.png" });
  await new Promise((r) => setTimeout(r, 5200));
  await (await p.$(".hero")).screenshot({ path: "docs/hero.png" });
  await p.screenshot({ path: "docs/card.png", fullPage: true });

  const text = await p.evaluate(() => document.body.innerText);
  const dashes = text.split("\n").filter((l) => /[\u2010-\u2015\u2212-]/.test(l));
  if (dashes.length) problems.push(`dash in visible text:\n  ${dashes.join("\n  ")}`);
  // A control character or a replacement glyph renders as a box: bad data reached the page.
  const boxes = text.split("\n").filter((l) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f�]/.test(l));
  if (boxes.length) problems.push(`unrenderable character in visible text:\n  ${boxes.join("\n  ")}`);

  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await p.reload({ waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 8600));
  const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 0) problems.push(`phone layout overflows by ${over}px`);
  await p.screenshot({ path: "docs/phone.png", fullPage: true });

  if (errors.length) problems.push(`console errors:\n  ${errors.join("\n  ")}`);
} finally {
  await b.close();
}
console.log("wrote docs/hero_midwalk.png, docs/hero.png, docs/card.png, docs/phone.png");
if (problems.length) { console.log(`PROBLEMS\n${problems.join("\n")}`); process.exit(1); }
console.log("checks: no dashes or unrenderable characters in visible text, no phone overflow, no console errors");
