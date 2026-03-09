#!/usr/bin/env python3
"""
Main orchestrator for the ShopDashboard data pipeline.

Fetches data from Harvest and Google Calendar iCal feeds,
computes metrics, and writes JSON files to data/.
"""

import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

# Add pipeline dir to path for imports
sys.path.insert(0, os.path.dirname(__file__))

from fetch_harvest import get_tech_users, get_time_entries, get_all_task_assignments
from compute_productivity import compute_productivity
from compute_helpers_hurters import compute_helpers_hurters
from fetch_calendar import fetch_events
from fetch_checkout import fetch_checkout_data

# Configuration
CONFIG = {
    "productivity_target_pct": 75,
    "pto_task_names": ["Paid Time Off"],
    "tech_role_filter": "Tech",
    "helpers_hurters_top_n": 10,
    "calendar_weeks_ahead": 4,
    "history_months": 12,
}

DATA_DIR = Path(__file__).parent.parent / "data"


def write_json(filename, data):
    """Write data to a JSON file in the data/ directory."""
    DATA_DIR.mkdir(exist_ok=True)
    filepath = DATA_DIR / filename
    with open(filepath, "w") as f:
        json.dump(data, f, indent=2)
    print(f"  Wrote {filepath} ({os.path.getsize(filepath)} bytes)")


def main():
    print("=" * 60)
    print("ShopDashboard Data Pipeline")
    print("=" * 60)

    today = date.today()
    print(f"Date: {today.isoformat()}")

    # Determine date range: 12 months back from start of current month
    first_of_month = today.replace(day=1)
    history_start = first_of_month
    for _ in range(CONFIG["history_months"]):
        history_start = (history_start - timedelta(days=1)).replace(day=1)

    print(f"Fetching data from {history_start} to {today}")

    # --- Harvest Data ---
    print("\n[1/6] Fetching Tech users from Harvest...")
    tech_users = get_tech_users(CONFIG["tech_role_filter"])
    print(f"  Found {len(tech_users)} Tech users: {', '.join(tech_users.values())}")

    if not tech_users:
        print("  WARNING: No Tech users found. Check tech_role_filter config.")
        print("  Continuing anyway to generate empty data files...")

    tech_user_ids = set(tech_users.keys())

    print("\n[2/6] Fetching time entries from Harvest...")
    all_entries = get_time_entries(history_start, today)
    print(f"  Fetched {len(all_entries)} total time entries")

    # Current month entries for helpers/hurters
    current_month_entries = [
        e for e in all_entries
        if e["spent_date"].startswith(today.strftime("%Y-%m"))
    ]
    print(f"  Current month ({today.strftime('%Y-%m')}): {len(current_month_entries)} entries")

    print("\n[3/6] Fetching task assignments from Harvest...")
    task_assignments = get_all_task_assignments()
    print(f"  Fetched assignments for {len(task_assignments)} projects")

    # --- Compute Metrics ---
    print("\n[4/6] Computing metrics...")

    print("  Computing productivity...")
    productivity_data = compute_productivity(all_entries, tech_user_ids, CONFIG)
    current_pct = productivity_data["current_month"]["productivity_pct"]
    print(f"  Current month productivity: {current_pct}%")

    print("  Computing helpers/hurters...")
    hh_data = compute_helpers_hurters(
        current_month_entries, tech_user_ids, task_assignments, CONFIG
    )
    print(f"  Found {len(hh_data['helpers'])} helper groups, {len(hh_data['project_hurters'])} project hurters")

    # --- Calendar Events ---
    print("\n[5/6] Fetching calendar events...")
    events_data = fetch_events(CONFIG)
    total_events = sum(
        len(day["events"])
        for week in events_data["weeks"]
        for day in week["days"]
    )
    print(f"  Found {total_events} events over {CONFIG['calendar_weeks_ahead']} weeks")

    # --- Checkout Data ---
    print("\n[6/6] Fetching vehicle checkout data...")
    has_checkout_key = bool(os.environ.get("GOOGLE_SERVICE_ACCOUNT_KEY", ""))
    if has_checkout_key:
        checkout_data = fetch_checkout_data()
        print(f"  Found {len(checkout_data['vehicles'])} vehicles")
    else:
        print("  GOOGLE_SERVICE_ACCOUNT_KEY not set, skipping checkout data")
        checkout_data = None

    # --- Write JSON Files ---
    print("\nWriting JSON files...")
    write_json("productivity.json", productivity_data)
    write_json("helpers-hurters.json", hh_data)
    write_json("events.json", events_data)
    if checkout_data:
        write_json("checkout.json", checkout_data)

    print("\nDone!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
