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

/**
 * Update the "Last updated" timestamp in the header.
 */
function updateTimestamp(elementId, source) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const now = new Date();
    const opts = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' };
    const sourceLabel = source ? `<span style="font-size:13px">${source}</span><br>` : '';
    el.innerHTML = `${sourceLabel}Last updated<br><strong>${now.toLocaleDateString('en-US', opts)}</strong>`;
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
