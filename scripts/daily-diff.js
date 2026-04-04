#!/usr/bin/env node
/**
 * Compare current checkout data against stored snapshot hashes,
 * detect punchlist additions/removals/status changes, and DM a
 * summary to Alex on Slack.
 *
 * Usage:
 *   node scripts/daily-diff.js              # post diff to Alex
 *   node scripts/daily-diff.js --dry-run    # print diff, no Slack
 *
 * Environment:
 *   SLACK_BOT_TOKEN — required for Slack posting
 */

const crypto = require("crypto");
const https = require("https");
const path = require("path");
const fs = require("fs");

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const ALEX_USER_ID = "U04KE2KJ1S4";

const TRACKED = [
  "Barton", "Berke", "Miner", "Preheim",
  "Connolly", "Witham", "Ferdman", "McDonough",
];

const VEHICLE_LABELS = {
  Barton: "1959 Chevrolet Impala",
  Berke: "1969 Alfa Spyder",
  Miner: "Porsche 993",
  Preheim: "1972 Chevrolet Blazer",
  Connolly: "1958 Mercedes 220S",
  Witham: "1951 Chevrolet 3100",
  Ferdman: "1966 Volkswagen Micro Bus",
  McDonough: "1977 Lotus Esprit",
};

const DATA_DIR = path.join(__dirname, "..", "data");
const PREV_SNAPSHOT = path.join(DATA_DIR, "snapshot-previous.json");

function slackPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: "slack.com",
        path: `/api/${endpoint}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${SLACK_TOKEN}`,
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { resolve(JSON.parse(buf)); }
          catch { reject(new Error(buf)); }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function cleanText(text) {
  // Return first line only for concise display
  return (text || "").split("\n")[0].trim();
}

function normalizeText(text) {
  // Strip date prefixes like "2026-03-xx:", "2026-03-28:", "3/28:" etc.
  // so reformatted items still match their originals.
  let t = cleanText(text);
  t = t.replace(/^\d{4}-\d{2}-[\dxX]{2}:\s*/, "");   // 2026-03-xx:
  t = t.replace(/^\d{1,2}\/\d{1,2}:\s*/, "");          // 3/28:
  t = t.replace(/^\d{4}-\d{2}-\d{2}:\s*/, "");          // 2026-03-28:
  return t.toLowerCase().trim();
}

function getOpenItems(vehicle) {
  const pl = vehicle.punchlist || {};
  const items = pl.items || [];
  return items
    .filter((i) => !i.done && i.text.trim() && i.text.trim() !== "-")
    .map((i) => i.text.trim());
}

function getDoneItems(vehicle) {
  const pl = vehicle.punchlist || {};
  const items = pl.items || [];
  return items
    .filter((i) => i.done && i.text.trim() && i.text.trim() !== "-")
    .map((i) => i.text.trim());
}

function diffVehicle(oldV, newV) {
  const changes = [];

  // Status change
  const oldStatus = (oldV && oldV.status) || "";
  const newStatus = (newV && newV.status) || "";
  if (oldStatus !== newStatus && newStatus) {
    changes.push({ type: "status", from: oldStatus, to: newStatus });
  }

  // Progress change
  const oldPct = (oldV && oldV.checkout) || 0;
  const newPct = (newV && newV.checkout) || 0;
  if (oldPct !== newPct) {
    changes.push({ type: "progress", from: oldPct, to: newPct });
  }

  // Punchlist diffs — compare by normalized text to ignore reformatting
  // (e.g. date prefixes being added/removed)
  const oldOpenRaw = oldV ? getOpenItems(oldV).map(cleanText) : [];
  const newOpenRaw = newV ? getOpenItems(newV).map(cleanText) : [];
  const oldDoneRaw = oldV ? getDoneItems(oldV).map(cleanText) : [];
  const newDoneRaw = newV ? getDoneItems(newV).map(cleanText) : [];

  // Build normalized lookup maps: normalizedText -> displayText
  const oldOpenNorm = new Map(oldOpenRaw.map((t) => [normalizeText(t), t]));
  const newOpenNorm = new Map(newOpenRaw.map((t) => [normalizeText(t), t]));
  const oldDoneNorm = new Map(oldDoneRaw.map((t) => [normalizeText(t), t]));
  const newDoneNorm = new Map(newDoneRaw.map((t) => [normalizeText(t), t]));

  // New open items (not previously open or done after normalization)
  for (const [norm, display] of newOpenNorm) {
    if (!oldOpenNorm.has(norm) && !oldDoneNorm.has(norm)) {
      changes.push({ type: "added", text: display });
    }
  }

  // Resolved items (were open, now done)
  for (const [norm, display] of newDoneNorm) {
    if (oldOpenNorm.has(norm)) {
      changes.push({ type: "resolved", text: display });
    }
  }

  // Removed items (were open, now gone entirely)
  for (const [norm, display] of oldOpenNorm) {
    if (!newOpenNorm.has(norm) && !newDoneNorm.has(norm)) {
      changes.push({ type: "removed", text: display });
    }
  }

  return changes;
}

function formatDate() {
  const now = new Date();
  const opts = { year: "numeric", month: "long", day: "numeric", timeZone: "America/Chicago" };
  return now.toLocaleDateString("en-US", opts);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  // Load current data
  const currentData = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "checkout.json"), "utf8")
  );
  const currentByOwner = {};
  for (const v of currentData.vehicles) {
    currentByOwner[v.owner] = v;
  }

  // Load previous snapshot
  let prevByOwner = {};
  try {
    const prev = JSON.parse(fs.readFileSync(PREV_SNAPSHOT, "utf8"));
    for (const v of prev.vehicles) {
      prevByOwner[v.owner] = v;
    }
  } catch {
    console.log("No previous snapshot found. Saving current as baseline.");
    fs.writeFileSync(PREV_SNAPSHOT, JSON.stringify(currentData, null, 2));
    return;
  }

  // Build diff
  const sections = [];
  let totalChanges = 0;

  for (const owner of TRACKED) {
    const oldV = prevByOwner[owner];
    const newV = currentByOwner[owner];
    if (!newV) continue;

    const changes = diffVehicle(oldV, newV);
    if (changes.length === 0) continue;

    totalChanges += changes.length;
    const label = VEHICLE_LABELS[owner] || "";
    const pct = newV.checkout.toFixed(1);
    const status = newV.status || "";
    let section = `*${owner}* — ${label} (${pct}%, ${status})`;

    for (const c of changes) {
      switch (c.type) {
        case "status":
          section += `\n  :arrows_counterclockwise: Status: ${c.from} → ${c.to}`;
          break;
        case "progress":
          const delta = (c.to - c.from).toFixed(1);
          const arrow = c.to > c.from ? ":chart_with_upwards_trend:" : ":chart_with_downwards_trend:";
          section += `\n  ${arrow} Progress: ${c.from}% → ${c.to}% (${delta > 0 ? "+" : ""}${delta}%)`;
          break;
        case "added":
          section += `\n  :new: ${c.text}`;
          break;
        case "resolved":
          section += `\n  :white_check_mark: ${c.text}`;
          break;
        case "removed":
          section += `\n  :x: Removed: ${c.text}`;
          break;
      }
    }

    sections.push(section);
  }

  if (sections.length === 0) {
    console.log("No punchlist changes detected today.");
    // Still save snapshot so we track from here
    fs.writeFileSync(PREV_SNAPSHOT, JSON.stringify(currentData, null, 2));
    return;
  }

  const message =
    `*Vehicle Checkout — Daily Changes*\n_${formatDate()}_\n\n` +
    sections.join("\n\n");

  console.log(message);

  if (!dryRun && SLACK_TOKEN) {
    const resp = await slackPost("chat.postMessage", {
      channel: ALEX_USER_ID,
      text: message,
    });
    if (resp.ok) {
      console.log("\nPosted to Alex's DMs.");
    } else {
      console.error(`\nSlack error: ${resp.error}`);
    }
  } else if (!SLACK_TOKEN) {
    console.log("\nSkipping Slack (no SLACK_BOT_TOKEN).");
  } else {
    console.log("\nDry run — not posting.");
  }

  // Save current as new baseline
  fs.writeFileSync(PREV_SNAPSHOT, JSON.stringify(currentData, null, 2));
  console.log("Snapshot saved.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
