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

// Regression check for the plan-list row-overlap bug: a fixed-height flex
// row (height: 18px, not min-height, no real table sizing) painted
// overflowing content over the next row instead of clipping or reflowing
// it, because the status column was missing white-space: nowrap ("Not
// started" wrapped to two lines). Originally band-aided with nowrap +
// overflow: hidden; now fixed structurally with real CSS table layout
// (see the isFindings check below for why not a literal <table>), so a
// row's height always genuinely fits its content instead of depending on
// every cell separately remembering not to wrap. The Gantt view was never
// affected since it has no wrapping text columns.
// Slices from one marker to the next — NOT to the next "</sc-if>", since
// both isPlanList and isFindings contain their own nested sc-if blocks
// (isAdding's form, a row's showAnswerBtn/isAnswering/hasAnswer) that
// close well before the real end of the outer block. Using the next
// sibling tab's start marker instead avoids truncating the slice before
// it ever reaches the table markup being checked.
function checkTableRegion(startMarker, endMarker, label) {
  const start = html.indexOf(startMarker);
  if (start === -1) {
    console.error(`check-dashboard-layout: could not find ${label} (${JSON.stringify(startMarker)}) in dashboard.html — did it get renamed or restructured?`);
    process.exit(1);
  }
  const end = html.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    console.error(`check-dashboard-layout: could not find the end marker (${JSON.stringify(endMarker)}) after ${label} — did it get renamed or restructured?`);
    process.exit(1);
  }
  return html.slice(start, end);
}

const planBlock = checkTableRegion("isPlanList", "isPlanGantt", "the plan-list view");
if (!/display:\s*table;/.test(planBlock) || !/display:\s*table-row/.test(planBlock) || !/display:\s*table-cell/.test(planBlock)) {
  console.error(
    "check-dashboard-layout: the plan-list view is no longer built with CSS table layout (display: table/table-row/table-cell) — a fixed-height flex row will silently reintroduce the row-overlap bug the moment any column's content is long enough to wrap."
  );
  process.exit(1);
}
const statusColMatch = planBlock.match(/<div style="display: table-cell; vertical-align: middle; white-space: nowrap;">/);
if (!statusColMatch) {
  console.error(
    "check-dashboard-layout: the plan-list status column lost white-space: nowrap — \"Not started\" wraps to two lines again."
  );
  process.exit(1);
}

// Regression check for the Findings-tab formatting/alignment bug: same
// root shape as the plan-list one (a flex fake table couldn't handle
// variable-height content — Phase/Disposition/Decided-by ended up
// vertically centered against a whole tall, wrapped paragraph instead of
// anchored to its top), fixed the same way with CSS table layout. Also
// guards against "fixing" it back to a literal <table>: a raw parse
// confirmed the browser's HTML5 tree-construction rules foster-parent
// row/cell elements straight out of this template runtime's <sc-for>
// repeat element whenever it wraps them inside a real <table>, since
// <sc-for> isn't part of the table content model — which would silently
// break the whole findings list (sc-for ends up with no children) rather
// than fail loudly.
const findingsBlock = checkTableRegion("isFindings", "isLog", "the Findings tab");
if (!/display:\s*table;/.test(findingsBlock) || !/display:\s*table-row/.test(findingsBlock) || !/display:\s*table-cell/.test(findingsBlock)) {
  console.error(
    "check-dashboard-layout: the Findings tab is no longer built with CSS table layout — Phase/Disposition/Decided-by will drift back to floating at the vertical center of a tall wrapped finding instead of staying anchored to its top."
  );
  process.exit(1);
}
if (/<table[\s>]/.test(findingsBlock) || /<tr[\s>]/.test(findingsBlock) || /<td[\s>]/.test(findingsBlock)) {
  console.error(
    "check-dashboard-layout: the Findings tab now contains a literal table/tr/td element — this template runtime's <sc-for> gets foster-parented out of a real <table> by the browser's own HTML parser, which silently breaks the findings list instead of failing loudly. Use CSS table layout (display: table/table-row/table-cell) on plain divs instead."
  );
  process.exit(1);
}
if (!findingsBlock.includes("white-space: pre-wrap")) {
  console.error(
    "check-dashboard-layout: the Findings tab's finding text lost white-space: pre-wrap — a coordinator's multi-paragraph write-up will collapse back into one unbroken wall of text."
  );
  process.exit(1);
}

console.log("check-dashboard-layout: ok — dot menu still uses position: fixed anchored to a measured rect.");
console.log("check-dashboard-layout: ok — plan-list uses CSS table layout and the status column still doesn't wrap.");
console.log("check-dashboard-layout: ok — Findings tab uses CSS table layout, not a literal table, and keeps pre-wrap text.");
