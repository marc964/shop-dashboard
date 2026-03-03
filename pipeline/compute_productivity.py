"""
Compute productivity metrics from Harvest time entries.

Productivity = billable_hours / (total_hours - pto_hours) * 100
Only includes Tech-role users.
"""

from datetime import date, timedelta
from collections import defaultdict


def compute_productivity(time_entries, tech_user_ids, config):
    """
    Compute productivity metrics from time entries.

    Args:
        time_entries: list of Harvest time entry dicts
        tech_user_ids: set of user IDs with Tech role
        config: dict with productivity_target_pct, pto_task_names

    Returns:
        dict with monthly, weekly, daily breakdowns and comparisons
    """
    target = config["productivity_target_pct"]
    pto_names = set(config["pto_task_names"])

    # Filter to Tech users only
    entries = [e for e in time_entries if e["user"]["id"] in tech_user_ids]

    # Group entries by month key (YYYY-MM)
    by_month = defaultdict(lambda: {"billable": 0.0, "total": 0.0, "pto": 0.0})
    by_week = defaultdict(lambda: {"billable": 0.0, "total": 0.0, "pto": 0.0})
    by_day = defaultdict(lambda: {"billable": 0.0, "total": 0.0, "pto": 0.0})

    for e in entries:
        hours = e.get("hours", 0)
        entry_date = e["spent_date"]  # "YYYY-MM-DD"
        month_key = entry_date[:7]  # "YYYY-MM"
        task_name = e.get("task", {}).get("name", "")
        is_pto = task_name in pto_names
        is_billable = e.get("billable", False)

        # Parse date for week calculation
        d = date.fromisoformat(entry_date)
        # ISO week: Monday-start week number
        week_key = f"{d.year}-W{d.isocalendar()[1]:02d}"

        by_month[month_key]["total"] += hours
        by_week[week_key]["total"] += hours
        by_day[entry_date]["total"] += hours

        if is_pto:
            by_month[month_key]["pto"] += hours
            by_week[week_key]["pto"] += hours
            by_day[entry_date]["pto"] += hours
        elif is_billable:
            by_month[month_key]["billable"] += hours
            by_week[week_key]["billable"] += hours
            by_day[entry_date]["billable"] += hours

    def calc_pct(bucket):
        denom = bucket["total"] - bucket["pto"]
        if denom <= 0:
            return 0.0
        return round(bucket["billable"] / denom * 100, 1)

    # Build monthly data (sorted, last 12 months)
    today = date.today()
    current_month = today.strftime("%Y-%m")

    monthly = []
    for key in sorted(by_month.keys()):
        pct = calc_pct(by_month[key])
        monthly.append({
            "month": key,
            "productivity_pct": pct,
            "billable_hours": round(by_month[key]["billable"], 1),
            "total_hours": round(by_month[key]["total"], 1),
            "pto_hours": round(by_month[key]["pto"], 1),
        })
    # Keep last 12 months
    monthly = monthly[-12:]

    # Current month data
    current = by_month.get(current_month, {"billable": 0, "total": 0, "pto": 0})
    current_pct = calc_pct(current)

    # Previous month
    first_of_month = today.replace(day=1)
    prev_month_date = first_of_month - timedelta(days=1)
    prev_month_key = prev_month_date.strftime("%Y-%m")
    prev = by_month.get(prev_month_key, {"billable": 0, "total": 0, "pto": 0})
    prev_pct = calc_pct(prev)

    # Last quarter average (3 months before current)
    quarter_months = []
    d = first_of_month
    for _ in range(3):
        d = (d - timedelta(days=1)).replace(day=1)
        quarter_months.append(d.strftime("%Y-%m"))
    quarter_pcts = [calc_pct(by_month[m]) for m in quarter_months if m in by_month]
    quarter_avg = round(sum(quarter_pcts) / len(quarter_pcts), 1) if quarter_pcts else 0

    # Last week productivity
    last_week_start = today - timedelta(days=today.weekday() + 7)
    last_week_key = f"{last_week_start.year}-W{last_week_start.isocalendar()[1]:02d}"
    last_week = by_week.get(last_week_key, {"billable": 0, "total": 0, "pto": 0})
    last_week_pct = calc_pct(last_week)

    # Current month weekly breakdown
    current_month_weeks = []
    for key in sorted(by_week.keys()):
        # Check if this week falls in current month
        # Use the Monday of the week to determine month
        year, week_num = key.split("-W")
        week_start = date.fromisocalendar(int(year), int(week_num), 1)
        if week_start.strftime("%Y-%m") == current_month or (
            week_start + timedelta(days=4)
        ).strftime("%Y-%m") == current_month:
            pct = calc_pct(by_week[key])
            current_month_weeks.append({
                "week": key,
                "productivity_pct": pct,
                "billable_hours": round(by_week[key]["billable"], 1),
                "total_hours": round(by_week[key]["total"], 1),
            })

    # Current month daily breakdown
    current_month_days = []
    for key in sorted(by_day.keys()):
        if key.startswith(current_month):
            pct = calc_pct(by_day[key])
            current_month_days.append({
                "date": key,
                "productivity_pct": pct,
                "billable_hours": round(by_day[key]["billable"], 1),
                "total_hours": round(by_day[key]["total"], 1),
            })

    return {
        "generated_at": today.isoformat(),
        "target_pct": target,
        "current_month": {
            "month": current_month,
            "productivity_pct": current_pct,
            "billable_hours": round(current["billable"], 1),
            "total_hours": round(current["total"], 1),
            "pto_hours": round(current["pto"], 1),
        },
        "comparisons": {
            "vs_last_month": {
                "label": "vs Last Month",
                "value": prev_pct,
                "delta": round(current_pct - prev_pct, 1),
            },
            "vs_last_quarter": {
                "label": "vs Last Quarter Avg",
                "value": quarter_avg,
                "delta": round(current_pct - quarter_avg, 1),
            },
            "vs_last_week": {
                "label": "vs Last Week",
                "value": last_week_pct,
                "delta": round(current_pct - last_week_pct, 1),
            },
            "vs_target": {
                "label": "vs Target",
                "value": target,
                "delta": round(current_pct - target, 1),
            },
        },
        "monthly": monthly,
        "current_month_weeks": current_month_weeks,
        "current_month_days": current_month_days,
    }
