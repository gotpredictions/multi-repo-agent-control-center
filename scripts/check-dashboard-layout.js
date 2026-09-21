#!/usr/bin/env node
// Regression check for the repo-row dot menu clipping bug: the popup must
// be position: fixed, anchored to a rect measured at click time — not
// position: absolute against the table row. The row lives inside
// .cc-scrollx (overflow-x: auto, for the wide table on narrow windows),
// and per the CSS overflow spec, leaving overflow-y unspecified while
// overflow-x is non-'visible' makes overflow-y compute to 'auto' too —
// so that ancestor was silently clipping the popup's bottom. A fixed
// element's containing block is the viewport (nothing here sets
// transform/filter/perspective), so it escapes that clip. See the
// comment above `toggleMenu` in dashboard.html.
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "media", "dashboard.html");
const html = fs.readFileSync(file, "utf8");

const menuStyleMatch = html.match(/menuStyle:\s*\(function \(\) \{[\s\S]*?\}\)\(\),/);
if (!menuStyleMatch) {
  console.error(
    "check-dashboard-layout: could not find the row.menuStyle block in dashboard.html — did it get renamed or restructured?"
  );
  process.exit(1);
}
const menuStyleBlock = menuStyleMatch[0];

if (!menuStyleBlock.includes("position: fixed;")) {
  console.error(
    "check-dashboard-layout: row.menuStyle no longer uses position: fixed — it will be clipped again by .cc-scrollx's implied overflow-y: auto."
  );
  process.exit(1);
}
if (menuStyleBlock.includes("position: absolute")) {
  console.error(
    "check-dashboard-layout: row.menuStyle references position: absolute again — that is the exact regression this check guards against."
  );
  process.exit(1);
}

if (!html.includes("getBoundingClientRect")) {
  console.error(
    "check-dashboard-layout: toggleMenu no longer measures a rect via getBoundingClientRect — position: fixed needs real viewport coordinates, not an index-based guess."
  );
  process.exit(1);
}

// Regression check for the plan-list row-overlap bug: fixed-height rows
// (height: 18px, not min-height) painted overflowing content over the
// next row instead of clipping it, because a column was missing
// white-space: nowrap (the status column's "Not started" wrapped to two
// lines) and the row itself had no overflow: hidden to contain it. The
// Gantt view was unaffected since it has no wrapping text columns.
const planRowStart = html.indexOf('<div class="cc-row" style="padding: 0; height: 18px');
if (planRowStart === -1) {
  console.error(
    "check-dashboard-layout: could not find the plan-list row (height: 18px) in dashboard.html — did it get renamed or restructured?"
  );
  process.exit(1);
}
const planRowEnd = html.indexOf("</sc-for>", planRowStart);
const planRowBlock = html.slice(planRowStart, planRowEnd);

if (!planRowBlock.includes("overflow: hidden")) {
  console.error(
    "check-dashboard-layout: the plan-list row (height: 18px) lost its overflow: hidden — wrapped text in any column will bleed into the next row again."
  );
  process.exit(1);
}
const statusColMatch = planRowBlock.match(/<div style="width: 100px;[^"]*">/);
if (!statusColMatch || !statusColMatch[0].includes("white-space: nowrap")) {
  console.error(
    "check-dashboard-layout: the plan-list status column lost white-space: nowrap — \"Not started\" wraps to two lines and overlaps the next row (the exact regression this check guards against)."
  );
  process.exit(1);
}

console.log("check-dashboard-layout: ok — dot menu still uses position: fixed anchored to a measured rect.");
console.log("check-dashboard-layout: ok — plan-list rows still clip/nowrap instead of overlapping.");
