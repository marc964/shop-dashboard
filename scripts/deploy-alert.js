#!/usr/bin/env node
/**
 * deploy-alert.js
 *
 * Decides whether a GitHub Pages deploy failure is worth alerting on, and if
 * so posts an informative message to Slack (#moment-ops).
 *
 * A single failed deploy is NOT actionable: the data pipeline still succeeded,
 * the live site keeps serving the last good version, and the next scheduled run
 * (~15 min later) redeploys with a fresh commit SHA and usually succeeds. So we
 * only escalate when deploys have failed enough times in a row that the shop-TV
 * dashboards are meaningfully stale.
 *
 * Env:
 *   DEPLOY_OK             "true" if our deploy step ultimately succeeded
 *   GITHUB_TOKEN          token to read the repo's Pages deployment history
 *   GITHUB_REPOSITORY     "owner/repo"
 *   GITHUB_RUN_ID         current Actions run id (for the link)
 *   GITHUB_SERVER_URL     e.g. https://github.com
 *   SLACK_BOT_TOKEN       Slack bot token (same one daily-diff.js uses)
 *   SLACK_CHANNEL         target channel (default "#moment-ops")
 *   STALE_AFTER_FAILURES  consecutive failures before alerting (default 3)
 */

const https = require("https");

const DEPLOY_OK = process.env.DEPLOY_OK === "true";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || "";
const RUN_ID = process.env.GITHUB_RUN_ID || "";
const SERVER = process.env.GITHUB_SERVER_URL || "https://github.com";
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || "#moment-ops";
const THRESHOLD = parseInt(process.env.STALE_AFTER_FAILURES || "3", 10);
const REMINDER_EVERY = 12; // re-alert every ~12 failures (~3h at 15-min cadence)

function ghGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        path,
        method: "GET",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          "User-Agent": "shop-dashboard-deploy-alert",
          Accept: "application/vnd.github+json",
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(buf)); }
            catch (e) { reject(new Error(`bad JSON from ${path}: ${e.message}`)); }
          } else {
            reject(new Error(`GitHub ${res.statusCode} for ${path}: ${buf.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function slackPost(text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ channel: SLACK_CHANNEL, text, unfurl_links: false });
    const req = https.request(
      {
        hostname: "slack.com",
        path: "/api/chat.postMessage",
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

// Latest status state for a deployment ("success" | "failure" | "error" | ...).
async function statusOf(deploymentId) {
  const statuses = await ghGet(`/repos/${REPO}/deployments/${deploymentId}/statuses?per_page=1`);
  return statuses[0] ? statuses[0].state : null;
}

function minutesSince(iso) {
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000);
}

function ageStr(mins) {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

async function main() {
  const runUrl = `${SERVER}/${REPO}/actions/runs/${RUN_ID}`;

  // Newest-first list of recent github-pages deployments (includes this run's).
  let deployments;
  try {
    deployments = await ghGet(`/repos/${REPO}/deployments?environment=github-pages&per_page=20`);
  } catch (e) {
    console.warn(`deploy-alert: could not read deployment history (${e.message}); skipping.`);
    return; // never fail the run over the alerter itself
  }

  // Walk from newest, pairing each with its latest status.
  const states = [];
  for (const d of deployments) {
    try { states.push(await statusOf(d.id)); }
    catch { states.push(null); }
  }

  if (DEPLOY_OK) {
    // Did we just recover from a sustained outage? Count failures immediately
    // preceding this fresh success (skip the leading success entries).
    let i = 0;
    while (i < states.length && (states[i] === "success" || states[i] === "inactive")) i++;
    let priorFails = 0;
    while (i < states.length && (states[i] === "failure" || states[i] === "error")) { priorFails++; i++; }
    if (priorFails >= THRESHOLD && SLACK_TOKEN) {
      await slackPost(
        `:white_check_mark: *Shop dashboard deploy recovered* — GitHub Pages is deploying again ` +
        `after ${priorFails} consecutive failures. The shop-TV dashboards are back to live data.`
      );
      console.log(`deploy-alert: posted recovery notice (${priorFails} prior failures).`);
    } else {
      console.log("deploy-alert: deploy succeeded, nothing to report.");
    }
    return;
  }

  // Deploy failed — count consecutive failures from the newest deployment.
  let consecutive = 0;
  for (const s of states) {
    if (s === "failure" || s === "error") consecutive++;
    else break;
  }

  // Age of the last good deploy still being served.
  const lastGood = deployments.find((_, idx) => states[idx] === "success" || states[idx] === "inactive");
  const staleFor = lastGood ? ageStr(minutesSince(lastGood.created_at)) : "unknown";

  if (consecutive < THRESHOLD) {
    console.warn(
      `::warning::Pages deploy failed (${consecutive} in a row). ` +
      `Site still serving last good version (${staleFor} old); should self-heal next run. Not alerting yet.`
    );
    return;
  }

  const shouldAlert = consecutive === THRESHOLD || consecutive % REMINDER_EVERY === 0;
  console.warn(
    `::warning::Pages deploy failed ${consecutive}x in a row; dashboards stale for ~${staleFor}.`
  );
  if (!shouldAlert) {
    console.log("deploy-alert: past threshold but between reminders; not re-posting.");
    return;
  }
  if (!SLACK_TOKEN) {
    console.log("deploy-alert: SLACK_BOT_TOKEN not set; skipping Slack post.");
    return;
  }

  const msg =
    `:warning: *Shop dashboard deploys are failing*\n` +
    `The GitHub Pages deploy has failed *${consecutive} times in a row*. The shop-TV dashboards are ` +
    `showing stale data (last good update ~*${staleFor}* ago).\n` +
    `This is a *GitHub Pages* problem on their end — the data pipeline itself is succeeding, so no data is lost. ` +
    `It normally self-heals within a run or two.\n` +
    `• GitHub status: https://www.githubstatus.com\n` +
    `• Latest run: ${runUrl}`;
  const resp = await slackPost(msg);
  if (resp && resp.ok) console.log(`deploy-alert: posted alert to ${SLACK_CHANNEL}.`);
  else console.warn(`deploy-alert: Slack post failed: ${JSON.stringify(resp)}`);
}

main().catch((e) => {
  // The alerter must never be the reason a run goes red.
  console.warn(`deploy-alert: unexpected error (${e.message}); ignoring.`);
});
