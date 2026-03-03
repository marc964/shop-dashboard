"""
Harvest API client for ShopDashboard.

Fetches users, time entries, projects, and task assignments.
Auth via HARVEST_TOKEN and HARVEST_ACCOUNT_ID environment variables.
"""

import os
import requests
from datetime import date

HARVEST_BASE = "https://api.harvestapp.com/v2"


def get_headers():
    token = os.environ["HARVEST_TOKEN"]
    account_id = os.environ["HARVEST_ACCOUNT_ID"]
    return {
        "Authorization": f"Bearer {token}",
        "Harvest-Account-Id": account_id,
        "Content-Type": "application/json",
    }


def paginate(url, key, params=None):
    """Generic paginated GET for Harvest API."""
    headers = get_headers()
    params = dict(params or {})
    params.setdefault("per_page", 100)
    page = 1
    all_items = []
    while True:
        params["page"] = page
        resp = requests.get(url, headers=headers, params=params)
        resp.raise_for_status()
        data = resp.json()
        items = data.get(key, [])
        if not items:
            break
        all_items.extend(items)
        if page >= data.get("total_pages", 1):
            break
        page += 1
    return all_items


def get_users():
    """Fetch all users. Returns list of user dicts with id, name, roles, is_active."""
    return paginate(f"{HARVEST_BASE}/users", "users")


def get_tech_users(role_filter="Tech"):
    """Fetch users filtered by role. Returns dict of user_id -> user_name."""
    users = get_users()
    tech = {}
    for u in users:
        if not u.get("is_active"):
            continue
        roles = u.get("roles", [])
        if role_filter in roles:
            tech[u["id"]] = u["first_name"] + " " + u["last_name"]
    return tech


def get_time_entries(from_date, to_date, user_id=None):
    """
    Fetch time entries for a date range.
    Optionally filter by user_id.
    Returns list of time entry dicts.
    """
    params = {
        "from": from_date.isoformat() if isinstance(from_date, date) else from_date,
        "to": to_date.isoformat() if isinstance(to_date, date) else to_date,
    }
    if user_id:
        params["user_id"] = user_id
    return paginate(f"{HARVEST_BASE}/time_entries", "time_entries", params)


def get_projects():
    """Fetch all projects. Returns list of project dicts."""
    return paginate(f"{HARVEST_BASE}/projects", "projects")


def get_task_assignments(project_id):
    """Fetch task assignments for a project. Returns list with budget info."""
    return paginate(
        f"{HARVEST_BASE}/projects/{project_id}/task_assignments",
        "task_assignments",
    )


def get_all_task_assignments():
    """Fetch task assignments for all active projects. Returns dict of project_id -> list of assignments."""
    projects = get_projects()
    result = {}
    for p in projects:
        if not p.get("is_active"):
            continue
        assignments = get_task_assignments(p["id"])
        if assignments:
            result[p["id"]] = {
                "project_name": p["name"],
                "assignments": assignments,
            }
    return result
