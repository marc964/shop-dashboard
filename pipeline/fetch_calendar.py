"""
iCal feed parser for PTO and shop event calendars.

Fetches public .ics feeds and returns structured event data
for the next N weeks.
"""

import os
from datetime import date, datetime, timedelta

import requests
from dateutil.rrule import rrulestr
from icalendar import Calendar


def fetch_ical(url):
    """Fetch and parse an iCal feed. Returns icalendar.Calendar object."""
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return Calendar.from_ical(resp.content)


def extract_events(cal, start_date, end_date):
    """
    Extract events from an icalendar Calendar within a date range.
    Handles both single and recurring events.

    Returns list of dicts: {summary, start_date, end_date, all_day}
    """
    events = []

    for component in cal.walk():
        if component.name != "VEVENT":
            continue

        summary = str(component.get("SUMMARY", ""))
        dtstart = component.get("DTSTART")
        dtend = component.get("DTEND")
        rrule = component.get("RRULE")

        if not dtstart:
            continue

        dtstart_val = dtstart.dt
        dtend_val = dtend.dt if dtend else None

        # Determine if all-day event
        all_day = isinstance(dtstart_val, date) and not isinstance(dtstart_val, datetime)

        if all_day:
            ev_start = dtstart_val
            ev_end = dtend_val if dtend_val else ev_start + timedelta(days=1)
        else:
            ev_start = dtstart_val.date() if isinstance(dtstart_val, datetime) else dtstart_val
            ev_end = dtend_val.date() if isinstance(dtend_val, datetime) else (ev_start + timedelta(days=1))

        if rrule:
            # Handle recurring events
            try:
                rule_str = rrule.to_ical().decode("utf-8")
                rule = rrulestr(rule_str, dtstart=dtstart_val)
                # Get occurrences in our date range (with some buffer)
                range_start = datetime.combine(start_date, datetime.min.time())
                range_end = datetime.combine(end_date, datetime.max.time())
                if all_day:
                    range_start = start_date
                    range_end = end_date

                for occurrence in rule.between(range_start, range_end, inc=True):
                    occ_date = occurrence.date() if isinstance(occurrence, datetime) else occurrence
                    duration = ev_end - ev_start
                    events.append({
                        "summary": summary,
                        "start_date": occ_date.isoformat(),
                        "end_date": (occ_date + duration).isoformat(),
                        "all_day": all_day,
                    })
            except Exception:
                # If rrule parsing fails, fall back to single event
                if ev_start <= end_date and ev_end >= start_date:
                    events.append({
                        "summary": summary,
                        "start_date": ev_start.isoformat(),
                        "end_date": ev_end.isoformat(),
                        "all_day": all_day,
                    })
        else:
            # Single event — check if it falls in range
            if ev_start <= end_date and ev_end >= start_date:
                # For multi-day events, clamp to our range
                events.append({
                    "summary": summary,
                    "start_date": ev_start.isoformat(),
                    "end_date": ev_end.isoformat(),
                    "all_day": all_day,
                })

    return events


def fetch_events(config):
    """
    Fetch events from PTO and shop calendars for the next N weeks.

    Expects env vars: PTO_CALENDAR_URL, SHOP_CALENDAR_URL

    Returns structured event data organized by week and day.
    """
    weeks_ahead = config.get("calendar_weeks_ahead", 4)
    today = date.today()

    # Start from Monday of current week
    week_start = today - timedelta(days=today.weekday())
    end_date = week_start + timedelta(weeks=weeks_ahead) - timedelta(days=1)

    all_events = []

    # Fetch PTO calendar
    pto_url = os.environ.get("PTO_CALENDAR_URL", "")
    if pto_url:
        try:
            cal = fetch_ical(pto_url)
            events = extract_events(cal, week_start, end_date)
            for ev in events:
                ev["type"] = "pto"
            all_events.extend(events)
        except Exception as e:
            print(f"Warning: Failed to fetch PTO calendar: {e}")

    # Fetch shop calendar
    shop_url = os.environ.get("SHOP_CALENDAR_URL", "")
    if shop_url:
        try:
            cal = fetch_ical(shop_url)
            events = extract_events(cal, week_start, end_date)
            for ev in events:
                ev["type"] = "shop"
            all_events.extend(events)
        except Exception as e:
            print(f"Warning: Failed to fetch shop calendar: {e}")

    # Organize by week -> day
    weeks = []
    current = week_start
    for week_idx in range(weeks_ahead):
        w_start = current + timedelta(weeks=week_idx)
        days = []
        for day_offset in range(7):
            d = w_start + timedelta(days=day_offset)
            day_events = []
            for ev in all_events:
                ev_start = date.fromisoformat(ev["start_date"])
                ev_end = date.fromisoformat(ev["end_date"])
                if ev_start <= d < ev_end:
                    day_events.append({
                        "summary": ev["summary"],
                        "type": ev["type"],
                        "all_day": ev["all_day"],
                    })
            days.append({
                "date": d.isoformat(),
                "day_name": d.strftime("%A"),
                "is_today": d == today,
                "is_weekend": day_offset >= 5,
                "events": day_events,
            })
        weeks.append({
            "week_start": w_start.isoformat(),
            "week_label": f"Week of {w_start.strftime('%b %d')}",
            "is_current_week": week_idx == 0,
            "days": days,
        })

    return {
        "generated_at": today.isoformat(),
        "weeks": weeks,
    }
