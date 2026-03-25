#!/usr/bin/env node
/**
 * Screenshot vehicle summary cards and post changed ones to Slack.
 *
 * Usage:
 *   node scripts/screenshot.js                # detect changes, post to Slack
 *   node scripts/screenshot.js --force        # post all, ignore change detection
 *   node scripts/screenshot.js --dry-run      # screenshot only, no Slack posting
 *   node scripts/screenshot.js --owner Berke  # single vehicle only
 *
 * Environment:
 *   SLACK_BOT_TOKEN  — required for Slack posting
 *   BASE_URL         — override GitHub Pages URL (default: momentmotors.github.io)
 *   CHROME_PATH      — override Chrome executable path
 */

const puppeteer = require("puppeteer");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const path = require("path");
const fs = require("fs");

const BASE_URL =
  process.env.BASE_URL || "https://momentmotors.github.io/shop-dashboard";

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";

const CHANNEL_MAP = {
  Barton: { channel: "C072J7W987Q", label: "1959 Chevrolet Impala" },
  Berke: { channel: "C05P2NUBK29", label: "1969 Alfa Spyder" },
  Miner: { channel: "C02BTML5937", label: "Porsche 993" },
  Preheim: { channel: "C03UTAJLUP9", label: "1972 Chevrolet Blazer" },
  Connolly: { channel: "C03NSUP00J3", label: "1958 Mercedes 220S" },
  Witham: { channel: "C08C5HG569G", label: "1951 Chevrolet 3100" },
  Ferdman: { channel: "C08J6RGQJVA", label: "1966 Volkswagen Micro Bus" },
  McDonough: { channel: "C08J3H80473", label: "1977 Lotus Esprit" },
};

const DATA_DIR = path.join(__dirname, "..", "data");
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
const HASHES_FILE = path.join(DATA_DIR, "snapshot-hashes.json");

// --- Helpers ---

function loadHashes() {
  try {
    return JSON.parse(fs.readFileSync(HASHES_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveHashes(hashes) {
  fs.writeFileSync(HASHES_FILE, JSON.stringify(hashes, null, 2) + "\n");
}

function hashVehicle(vehicle) {
  const relevant = {
    checkout: vehicle.checkout,
    status: vehicle.status,
    punchlist: vehicle.punchlist,
  };
  return crypto
    .createHash("md5")
    .update(JSON.stringify(relevant))
    .digest("hex");
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    force: args.includes("--force"),
    dryRun: args.includes("--dry-run"),
    seed: args.includes("--seed"),
    owner: args.includes("--owner")
      ? args[args.indexOf("--owner") + 1]
      : null,
  };
}

// --- Slack v2 upload ---

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
          try {
            resolve(JSON.parse(buf));
          } catch {
            reject(new Error(buf));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function slackFormPost(endpoint, formData) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "slack.com",
        path: `/api/${endpoint}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${SLACK_TOKEN}`,
          ...formData.getHeaders(),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            reject(new Error(buf));
          }
        });
      }
    );
    req.on("error", reject);
    formData.pipe(req);
  });
}

function uploadRaw(uploadUrl, filePath) {
  return new Promise((resolve, reject) => {
    const fileData = fs.readFileSync(filePath);
    const url = new URL(uploadUrl);
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": fileData.length,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve(buf));
      }
    );
    req.on("error", reject);
    req.write(fileData);
    req.end();
  });
}

async function postToSlack(owner, filePath, pct) {
  const fileSize = fs.statSync(filePath).size;
  const filename = `${owner.toLowerCase()}-summary.png`;

  // Step 1: Get upload URL
  const urlResp = await slackPost("files.getUploadURLExternal", {
    filename,
    length: fileSize,
  });
  if (!urlResp.ok) {
    console.error(`    Slack upload URL failed: ${urlResp.error}`);
    return false;
  }

  // Step 2: Upload file data
  await uploadRaw(urlResp.upload_url, filePath);

  // Step 3: Complete upload and share to channel
  const info = CHANNEL_MAP[owner];
  const completeResp = await slackPost("files.completeUploadExternal", {
    files: [{ id: urlResp.file_id, title: `${owner} — ${info.label}` }],
    channel_id: info.channel,
    initial_comment: `Checkout summary update for *${owner}* — ${pct}%`,
  });
  if (!completeResp.ok) {
    console.error(`    Slack complete failed: ${completeResp.error}`);
    return false;
  }

  return true;
}

// --- Screenshot ---

async function screenshotVehicle(browser, owner) {
  const url = `${BASE_URL}/vehicle-summary.html?owner=${encodeURIComponent(owner)}`;
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });

  try {
    await page.waitForSelector(".summary-card", { timeout: 10000 });
  } catch {
    console.error(`  No summary card rendered for ${owner}`);
    await page.close();
    return null;
  }

  const card = await page.$(".summary-card");
  if (!card) {
    await page.close();
    return null;
  }

  const outPath = path.join(SNAPSHOT_DIR, `${owner.toLowerCase()}.png`);
  await card.screenshot({ path: outPath, type: "png" });
  await page.close();
  return outPath;
}

// --- Main ---

async function main() {
  const opts = parseArgs();
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  // Load checkout data for change detection
  const checkoutData = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "checkout.json"), "utf8")
  );
  const vehiclesByOwner = {};
  for (const v of checkoutData.vehicles) {
    vehiclesByOwner[v.owner] = v;
  }

  // Determine which owners to process
  const allOwners = opts.owner ? [opts.owner] : Object.keys(CHANNEL_MAP);

  // Change detection
  const oldHashes = loadHashes();
  const newHashes = { ...oldHashes };
  const changed = [];

  for (const owner of allOwners) {
    const vehicle = vehiclesByOwner[owner];
    if (!vehicle) {
      console.log(`  ${owner}: not found in checkout data, skipping`);
      continue;
    }
    const hash = hashVehicle(vehicle);
    newHashes[owner] = hash;

    if (opts.force || hash !== oldHashes[owner]) {
      changed.push(owner);
    }
  }

  // Seed mode: save hashes as baseline without posting
  if (opts.seed) {
    saveHashes(newHashes);
    console.log(`Seeded hashes for ${allOwners.length} vehicle(s). No posts sent.`);
    return;
  }

  if (changed.length === 0) {
    console.log("No vehicle data changed. Nothing to do.");
    saveHashes(newHashes);
    return;
  }

  console.log(
    `${changed.length} vehicle(s) changed: ${changed.join(", ")}`
  );

  // Screenshot changed vehicles
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  for (const owner of changed) {
    const vehicle = vehiclesByOwner[owner];
    const pct = vehicle.checkout.toFixed(1);
    console.log(`  ${owner} (${pct}%):`);

    const imgPath = await screenshotVehicle(browser, owner);
    if (!imgPath) continue;
    console.log(`    Screenshot saved`);

    if (!opts.dryRun && SLACK_TOKEN) {
      const ok = await postToSlack(owner, imgPath, pct);
      console.log(ok ? "    Posted to Slack" : "    Slack post failed");
    } else if (!SLACK_TOKEN) {
      console.log("    Skipping Slack (no SLACK_BOT_TOKEN)");
    } else {
      console.log("    Dry run — skipping Slack");
    }
  }

  await browser.close();

  // Save updated hashes
  saveHashes(newHashes);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
