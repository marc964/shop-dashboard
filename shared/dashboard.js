/* Moment Motor Co. — Shared Dashboard Utilities */

/**
 * Fetch JSON data from a co-located file.
 * Falls back gracefully if the file doesn't exist yet.
 */
async function fetchData(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

/**
 * Get CSS class suffix based on percentage value.
 * Returns: 'high', 'mid', 'low', or 'zero'
 */
function getPctClass(pct) {
    if (pct >= 80) return 'high';
    if (pct >= 30) return 'mid';
    if (pct > 0) return 'low';
    return 'zero';
}

/**
 * Get color class for productivity using bonus-tier thresholds.
 * Green (71%+): accelerators+
 * Orange (60–70%): baseline / small bonus
 * Red (<60%): below baseline
 */
function getProductivityClass(pct) {
    if (pct >= 71) return 'high';
    if (pct >= 60) return 'mid';
    return 'low';
}

/**
 * Get hex color for productivity using bonus-tier thresholds.
 */
function getProductivityColor(pct) {
    if (pct >= 71) return '#1a8a4a';
    if (pct >= 60) return '#f5a623';
    return '#d94040';
}

/**
 * Format a number as percentage string.
 */
function fmtPct(value) {
    return value.toFixed(1);
}

/**
 * Format hours with 1 decimal.
 */
function fmtHours(value) {
    return value.toFixed(1);
}

// How stale the data has to be before the header says so. Scheduled runs land
// every ~75-130 min in practice (GitHub throttles the */15 cron hard), so 3h is
// comfortably past normal jitter — it flags a stalled pipeline without crying
// wolf on an ordinary slow cycle.
const STALE_AMBER_MS = 3 * 60 * 60 * 1000;
const STALE_RED_MS = 6 * 60 * 60 * 1000;

/**
 * Human-readable age, e.g. "37 min ago" / "4h 10m ago" / "2 days ago".
 */
function formatAge(ms) {
    // Negative age means the viewing device's clock is behind the build clock;
    // report it as current rather than showing a nonsensical negative.
    const mins = Math.max(0, Math.round(ms / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const h = Math.floor(mins / 60), m = mins % 60;
    if (h < 24) return m ? `${h}h ${m}m ago` : `${h}h ago`;
    const d = Math.floor(h / 24);
    return d === 1 ? '1 day ago' : `${d} days ago`;
}

/**
 * Render the "Last updated" header from the DATA's build time.
 *
 * Deliberately not `new Date()`: that reports when the browser rendered the
 * page, and since the dashboards reload every 5 minutes it always looked fresh
 * no matter how old the numbers were. During a 20-hour pipeline outage the shop
 * TVs showed a "last updated" time tracking the current clock while displaying
 * days-old data. The header now states the age of the data itself and colours
 * itself once that age is abnormal, which makes a stalled pipeline visible on
 * the TV without needing any alerting at all.
 *
 * @param {string} elementId  header element to fill
 * @param {string} generatedAt  ISO 8601 UTC timestamp from the data file
 * @param {string} [source]  optional small label above the timestamp
 */
function updateTimestamp(elementId, generatedAt, source) {
    const el = document.getElementById(elementId);
    if (!el) return;

    const sourceLabel = source ? `<span style="font-size:13px">${source}</span><br>` : '';
    el.classList.remove('stale', 'very-stale');

    const built = generatedAt ? new Date(generatedAt) : null;
    if (!built || isNaN(built.getTime())) {
        // No usable timestamp: say so rather than substituting the clock, which
        // is the exact failure this function exists to remove.
        el.classList.add('very-stale');
        el.innerHTML = `${sourceLabel}Last updated<br><strong>unknown</strong>`;
        return;
    }

    const ageMs = Date.now() - built.getTime();
    if (ageMs >= STALE_RED_MS) el.classList.add('very-stale');
    else if (ageMs >= STALE_AMBER_MS) el.classList.add('stale');

    const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    el.innerHTML = `${sourceLabel}Last updated<br>` +
        `<strong>${built.toLocaleString('en-US', opts)}</strong><br>` +
        `<span class="age">${formatAge(ageMs)}</span>`;
}

/**
 * Set up auto-refresh for the page.
 * Default: 5 minutes (300000ms)
 */
function setupAutoRefresh(intervalMs) {
    intervalMs = intervalMs || 300000;
    setTimeout(function() { location.reload(); }, intervalMs);
}

/**
 * Format a delta value with + or - prefix and color class.
 */
function formatDelta(current, previous) {
    const delta = current - previous;
    const sign = delta >= 0 ? '+' : '';
    const cls = delta >= 0 ? 'pct-high' : 'pct-low';
    return { text: sign + delta.toFixed(1), cls: cls };
}

/**
 * Get short month name from month index (0-11).
 */
function monthName(monthIndex) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[monthIndex];
}
