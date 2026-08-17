#!/usr/bin/env node
/**
 * run-failure-alert.js
 *
 * Decides whether failed *runs* of "Update & Deploy Dashboard" are worth
 * alerting on, and if so DMs Marc on Slack.
 *
 * Sibling of deploy-alert.js, one level up. deploy-alert.js runs *inside* the
 * job and only sees Pages deploy failures; if the job never starts (GitHub
 * fails to acquire a hosted runner and cancels it before any step executes)
 * nothing in the job can report. That case used to surface only as GitHub's own
 * unconditional failure email, which fires on the first failure and can't tell
 * a one-off infra hiccup from a genuinely broken pipeline. This script applies
 * the same sustained-failure filter at the run level so that email can be
 * turned off.
 *
 * A single failed run is NOT actionable: no data is lost, the site keeps
 * serving the last good build, and the next scheduled run picks up where this
 * one left off. We only escalate once enough runs in a row have failed that the
 * shop-TV dashboards are meaningfully stale.
 *
 * Env:
 *   RUN_ID                the triggering run's id (for the link)
 *   RUN_CONCLUSION        its conclusion ("success", "failure", "cancelled", ...)
 *   RETRIED               "true" if a re-run was just queued — stay silent and
 *                         let that attempt's own completion decide
 *   WORKFLOW_FILE         workflow to inspect the history of (default update.yml)
 *   GITHUB_TOKEN          token to read the repo's Actions history
 *   GITHUB_REPOSITORY     "owner/repo"
 *   GITHUB_SERVER_URL     e.g. https://github.com
 *   SLACK_BOT_TOKEN       Slack bot token (same one deploy-alert.js uses)
 *   SLACK_ALERT_TARGET    DM target Slack user id (default Marc, UKJH79UGK)
 *   ALERT_AFTER_FAILURES  consecutive failed runs before alerting (default 2)
 *   WEDGED_AFTER_MINUTES  a run stuck un-started this long is a wedge (default 60)
 *   WEDGE_AUTOCANCEL      "true" to cancel a wedged run automatically (default true)
 */

const https = require("https");

const RUN_ID = process.env.RUN_ID || "";
const RUN_CONCLUSION = process.env.RUN_CONCLUSION || "";
const RETRIED = process.env.RETRIED === "true";
const WORKFLOW_FILE = process.env.WORKFLOW_FILE || "update.yml";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || "";
const SERVER = process.env.GITHUB_SERVER_URL || "https://github.com";
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
// A user id here makes chat.postMessage open a DM to that user.
const SLACK_TARGET = process.env.SLACK_ALERT_TARGET || "UKJH79UGK"; // Marc Davis
const THRESHOLD = parseInt(process.env.ALERT_AFTER_FAILURES || "2", 10);
const WEDGED_AFTER = parseInt(process.env.WEDGED_AFTER_MINUTES || "60", 10);
const WEDGE_AUTOCANCEL = (process.env.WEDGE_AUTOCANCEL || "true") === "true";
// Scheduled runs land every ~1-3h in practice (GitHub throttles */15 crons
// hard), so this is roughly a twice-daily nag while an outage persists.
const REMINDER_EVERY = 6;

function ghGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        path,
        method: "GET",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          "User-Agent": "shop-dashboard-run-failure-alert",
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

function ghPost(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          "User-Agent": "shop-dashboard-run-failure-alert",
          Accept: "application/vnd.github+json",
          "Content-Length": 0,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
          else reject(new Error(`GitHub ${res.statusCode} for ${path}: ${buf.slice(0, 200)}`));
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function slackPost(text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ channel: SLACK_TARGET, text, unfurl_links: false });
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

function minutesSince(iso) {
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000);
}

function ageStr(mins) {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// "Set up job" is generated by the runner, not by our workflow. It fails when
// GitHub cannot hand over a machine or cannot download the actions the job
// uses (codeload 429/503) — never because of anything in this repo.
const RUNNER_SETUP_STEP = "set up job";

/**
 * Classify a failed run:
 *   "no-steps" — nothing executed at all; GitHub never handed us a runner
 *   "setup"    — only the runner's own setup step ran and failed (action
 *                download / runner provisioning) — still GitHub, not us
 *   "ours"     — a step from our workflow actually ran and failed
 *
 * The setup case used to fall through to "ours" because `Set up job` is a real
 * step with a real failure conclusion, so an Actions outage was reported to
 * Marc as "likely ours — check the failing step". It isn't, and there is no
 * failing step of ours to check.
 */
async function classifyFailure(runId) {
  try {
    const { jobs } = await ghGet(`/repos/${REPO}/actions/runs/${runId}/jobs`);
    if (!jobs || !jobs.length) return "no-steps";

    const executed = jobs.flatMap((j) =>
      (j.steps || []).filter((s) => s.conclusion === "success" || s.conclusion === "failure")
    );
    if (!executed.length) return "no-steps";

    const ranOurs = executed.some((s) => (s.name || "").trim().toLowerCase() !== RUNNER_SETUP_STEP);
    return ranOurs ? "ours" : "setup";
  } catch {
    // Can't tell — say so rather than blaming either side.
    return "unknown";
  }
}

/**
 * Ask githubstatus.com whether Actions is currently degraded.
 *
 * Turns "likely ours" guesswork into evidence: during the 2026-08-17 Actions
 * outage every run failed in setup, and the honest message is "GitHub is down",
 * not "check your failing step". Public endpoint, no auth. Returns null if
 * unreachable — the alert still goes out, just without this line.
 */
function fetchGitHubStatus() {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "www.githubstatus.com",
        path: "/api/v2/summary.json",
        method: "GET",
        headers: { "User-Agent": "shop-dashboard-run-failure-alert" },
        timeout: 10000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            const d = JSON.parse(buf);
            const actions = (d.components || []).find((c) => c.name === "Actions");
            resolve({
              description: d.status && d.status.description,
              actions: actions && actions.status,
              degraded: !!(actions && actions.status && actions.status !== "operational"),
            });
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * Find a run that has been sitting un-started for ages ("waiting" on the
 * github-pages environment, or "queued"/"pending" behind it).
 *
 * This is the failure mode that actually needs a human. update.yml serialises
 * on a `shop-dashboard-data-commit` concurrency group with cancel-in-progress
 * false, so one wedged run holds the lock indefinitely; every later scheduled
 * run queues behind it and is evicted by the next one, landing as "cancelled"
 * with zero steps executed. That is indistinguishable from a runner-acquisition
 * cancellation by shape alone — but the remedy is the opposite. Infra hiccups
 * clear themselves; a wedge never does until the stuck run is cancelled.
 */
async function findWedgedRun() {
  try {
    const res = await ghGet(`/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=30`);
    const all = res.workflow_runs || [];

    // If a run is actively executing, the queue is moving and anything behind
    // it is waiting legitimately — not wedged. Only an un-started run with
    // nothing running ahead of it is holding the lock for real.
    if (all.some((r) => r.status === "in_progress")) return null;

    const stuck = all
      .filter((r) => r.status === "waiting" || r.status === "queued" || r.status === "pending")
      .filter((r) => minutesSince(r.created_at) >= WEDGED_AFTER);
    // Oldest first — the one at the head of the queue is the actual blocker.
    stuck.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return stuck[0] || null;
  } catch {
    return null;
  }
}

async function postFailureAlert(diagnosis, consecutive, staleFor, runUrl) {
  const msg =
    `:warning: *Shop dashboard pipeline is failing*\n` +
    `"Update & Deploy Dashboard" has failed *${consecutive} runs in a row*. The shop-TV dashboards ` +
    `are showing stale data (last good update ~*${staleFor}* ago).\n` +
    `${diagnosis}\n` +
    `• Latest run: ${runUrl}`;

  // Always log the diagnosis, so the run log is useful even with no Slack.
  console.log(`run-failure-alert: diagnosis ->\n${msg}`);
  if (!SLACK_TOKEN) {
    console.log("run-failure-alert: SLACK_BOT_TOKEN not set; skipping Slack post.");
    return;
  }

  const resp = await slackPost(msg);
  if (resp && resp.ok) console.log(`run-failure-alert: DMed alert to ${SLACK_TARGET}.`);
  else console.warn(`run-failure-alert: Slack post failed: ${JSON.stringify(resp)}`);
}

// Auto-cancel is off, or it failed — hand the wedge to a human with the fix.
function alertOnWedge(wedged, consecutive, staleFor, runUrl) {
  const diagnosis =
    `*This needs you — it will not clear on its own.*\n` +
    `Run \`${wedged.id}\` has been stuck in *${wedged.status}* for ` +
    `*${ageStr(minutesSince(wedged.created_at))}*, holding the ` +
    `\`shop-dashboard-data-commit\` concurrency lock. Every run since has queued behind it and ` +
    `been cancelled before starting.\n` +
    `Cancel the stuck run to release the lock; the next scheduled run then recovers on its own:\n` +
    `\`gh run cancel ${wedged.id} --repo ${REPO}\`\n` +
    `• Stuck run: ${SERVER}/${REPO}/actions/runs/${wedged.id}`;
  return postFailureAlert(diagnosis, consecutive, staleFor, runUrl);
}

async function main() {
  const runUrl = `${SERVER}/${REPO}/actions/runs/${RUN_ID}`;

  // A re-run was just queued for this same run; its completion will re-enter
  // this script. Alerting now would double-post at the same failure count.
  if (RETRIED) {
    console.log("run-failure-alert: a re-run was queued; deferring to that attempt.");
    return;
  }

  let runs;
  try {
    const res = await ghGet(
      `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?status=completed&per_page=20`
    );
    runs = res.workflow_runs || [];
  } catch (e) {
    console.warn(`run-failure-alert: could not read run history (${e.message}); skipping.`);
    return; // never fail over the alerter itself
  }
  if (!runs.length) {
    console.log("run-failure-alert: no completed runs to inspect.");
    return;
  }

  const failed = (r) => r.conclusion !== "success" && r.conclusion !== "skipped";

  if (!failed(runs[0])) {
    // Newest run is green. Announce recovery only on the run that actually
    // ended the streak — i.e. the one immediately after the last failure.
    // Skipping *all* leading successes instead would re-announce on every green
    // run until the failures aged out of this 20-run window, turning one
    // recovery into hours of duplicate DMs.
    let priorFails = 0;
    if (runs.length > 1 && failed(runs[1])) {
      let i = 1;
      while (i < runs.length && failed(runs[i])) { priorFails++; i++; }
    }

    if (priorFails >= THRESHOLD && SLACK_TOKEN) {
      await slackPost(
        `:white_check_mark: *Shop dashboard pipeline recovered* — "Update & Deploy Dashboard" is ` +
        `running again after ${priorFails} consecutive failed runs. The shop-TV dashboards are back ` +
        `to live data.`
      );
      console.log(`run-failure-alert: posted recovery notice (${priorFails} prior failures).`);
    } else {
      console.log("run-failure-alert: newest run succeeded, nothing to report.");
    }
    return;
  }

  // Newest run failed — count how many in a row.
  let consecutive = 0;
  for (const r of runs) {
    if (failed(r)) consecutive++;
    else break;
  }

  const lastGood = runs.find((r) => !failed(r));
  const staleFor = lastGood ? ageStr(minutesSince(lastGood.updated_at)) : "unknown";

  // Check for a wedge before the failure-count threshold: a stuck run never
  // clears itself, and every run queued behind it is already being cancelled,
  // so waiting for more failures just extends the blackout.
  const wedged = await findWedgedRun();

  if (wedged && WEDGE_AUTOCANCEL) {
    const stuckFor = ageStr(minutesSince(wedged.created_at));
    try {
      await ghPost(`/repos/${REPO}/actions/runs/${wedged.id}/cancel`);
    } catch (e) {
      console.warn(`run-failure-alert: could not cancel wedged run ${wedged.id} (${e.message}).`);
      // Fall through to the alert path so a human hears about it.
      return await alertOnWedge(wedged, consecutive, staleFor, runUrl);
    }
    console.log(`run-failure-alert: cancelled wedged run ${wedged.id} (stuck ${stuckFor}).`);
    if (SLACK_TOKEN) {
      await slackPost(
        `:wrench: *Shop dashboard pipeline unwedged automatically*\n` +
        `Run \`${wedged.id}\` was stuck in *${wedged.status}* for *${stuckFor}*, holding the ` +
        `\`shop-dashboard-data-commit\` lock and cancelling every run queued behind it ` +
        `(${consecutive} so far; dashboards ~*${staleFor}* stale).\n` +
        `I cancelled it to release the lock — the next scheduled run should recover on its own. ` +
        `No action needed unless this repeats.\n` +
        `• Stuck run: ${SERVER}/${REPO}/actions/runs/${wedged.id}`
      );
    }
    return;
  }

  if (wedged) return await alertOnWedge(wedged, consecutive, staleFor, runUrl);

  if (consecutive < THRESHOLD) {
    console.warn(
      `::warning::Run failed (${consecutive} in a row). Dashboards still serving data from ` +
      `${staleFor} ago; next scheduled run should self-heal. Not alerting yet.`
    );
    return;
  }

  const shouldAlert = consecutive === THRESHOLD || consecutive % REMINDER_EVERY === 0;
  console.warn(`::warning::Run failed ${consecutive}x in a row; dashboards stale for ~${staleFor}.`);
  if (!shouldAlert) {
    console.log("run-failure-alert: past threshold but between reminders; not re-posting.");
    return;
  }
  // Not wedged. Distinguish GitHub's infrastructure from our own code, and
  // check their status page rather than guessing.
  const [kind, status] = await Promise.all([classifyFailure(RUN_ID), fetchGitHubStatus()]);

  const statusLine = status && status.description
    ? `\n• GitHub status: *${status.description}* (Actions: ${status.actions}) — https://www.githubstatus.com`
    : `\n• GitHub status: https://www.githubstatus.com`;

  let diagnosis;
  if (kind === "no-steps") {
    diagnosis =
      `The jobs were *cancelled before any step ran* — GitHub failed to acquire a hosted runner. ` +
      `That's their infrastructure, not our pipeline: no data is lost and there is nothing to fix ` +
      `on our end. It clears on its own.${statusLine}`;
  } else if (kind === "setup") {
    diagnosis =
      `The job failed in *Set up job*, before any of our steps ran — GitHub could not provision the ` +
      `runner or download the actions the job uses. Nothing in this repo is involved and there is ` +
      `no failing step of ours to look at. No data is lost; it clears when they recover.${statusLine}`;
  } else if (status && status.degraded) {
    // A step of ours failed, but GitHub is unhealthy — don't assert it's us.
    diagnosis =
      `A step of ours ran and failed, so this *may* be our code — but GitHub Actions is currently ` +
      `degraded, which can cause step failures that look like ours. Check the failing step, and ` +
      `re-check once they recover before digging deep.${statusLine}`;
  } else if (kind === "unknown") {
    diagnosis =
      `Could not read the run's step detail to tell whose failure this is. Check the run log.${statusLine}`;
  } else {
    diagnosis =
      `A step of ours ran and failed, and GitHub reports Actions healthy — so this one is likely ` +
      `ours. Check the failing step in the run log.`;
  }

  await postFailureAlert(diagnosis, consecutive, staleFor, runUrl);
}

main().catch((e) => {
  // The alerter must never be the reason a run goes red.
  console.warn(`run-failure-alert: unexpected error (${e.message}); ignoring.`);
});
