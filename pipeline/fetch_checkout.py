#!/usr/bin/env python3
"""
Fetch vehicle checkout data from Google Sheets (Ampere + AEM).

Uses the Google Sheets API with service account authentication.
Reads vehicle overview metrics from both spreadsheets and merges them.
"""

import json
import os
from datetime import datetime, timezone

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

AMPERE_SHEET_ID = "1_t0l_nl-LDBQP_hqh1Y6qbnASHwg2lDLinA942aSqkY"
AEM_SHEET_ID = "1YFNmS48kw7jqkT4VGE1gS3Eyk-nTL0j0iKiKL24STu8"

# Sub-metric row labels for Ampere "Vehicles Overview"
AMPERE_SUB_METRIC_LABELS = [
    "BMS Checkout",
    "Inverter Checkout",
    "PMU Checkout",
    "Raptor Configuration",
    "Functional Testing",
]

# Display names (shorter) for Ampere sub-metrics
AMPERE_SUB_METRIC_DISPLAY = {
    "BMS Checkout": "BMS",
    "Inverter Checkout": "Inverter",
    "PMU Checkout": "PMU",
    "Raptor Configuration": "Raptor",
    "Functional Testing": "Functional",
}


def get_credentials():
    """Get Google service account credentials from env var."""
    key_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_KEY", "")
    if not key_json:
        raise RuntimeError(
            "GOOGLE_SERVICE_ACCOUNT_KEY env var not set. "
            "Set it to the JSON contents of the service account key file."
        )
    info = json.loads(key_json)
    return Credentials.from_service_account_info(info, scopes=SCOPES)


def get_sheets_service():
    """Build and return a Google Sheets API service."""
    creds = get_credentials()
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def parse_pct(value):
    """Parse a percentage value from a cell. Handles '88.7%', 0.887, 88.7, etc."""
    if isinstance(value, (int, float)):
        # Sheets returns percentages as decimals (0.887) via effectiveValue
        if 0 < value <= 1:
            return round(value * 100, 1)
        return round(value, 1)
    s = str(value).strip().rstrip("%")
    try:
        return round(float(s), 1)
    except (ValueError, TypeError):
        return 0.0


def fetch_values(service, spreadsheet_id, range_str):
    """Fetch cell values from a sheet range."""
    result = service.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id,
        range=range_str,
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute()
    return result.get("values", [])


def parse_ampere_punchlist(service):
    """
    Parse punchlist items from Ampere 'Vehicles' tab.

    Finds the first row containing 'punch list' in column A,
    then reads Item rows below it. Uses grid data for strikethrough detection.
    Returns dict mapping owner name → punchlist data.
    """
    # Need grid data for strikethrough detection
    result = service.spreadsheets().get(
        spreadsheetId=AMPERE_SHEET_ID,
        ranges=["Vehicles"],
        includeGridData=True,
    ).execute()

    sheets = result.get("sheets", [])
    if not sheets:
        return {}

    grid_data = sheets[0].get("data", [])
    if not grid_data:
        return {}

    row_data = grid_data[0].get("rowData", [])
    if not row_data:
        return {}

    def get_cell(row_idx, col_idx):
        if row_idx >= len(row_data):
            return {}
        values = row_data[row_idx].get("values", [])
        if col_idx < len(values):
            return values[col_idx]
        return {}

    def cell_text(cell):
        ev = cell.get("effectiveValue", {})
        if "stringValue" in ev:
            return ev["stringValue"].strip()
        if "numberValue" in ev:
            return str(ev["numberValue"])
        return cell.get("formattedValue", "").strip()

    def is_strikethrough(cell):
        fmt = cell.get("effectiveFormat", {})
        text_fmt = fmt.get("textFormat", {})
        if text_fmt.get("strikethrough", False):
            return True
        # Also check per-run formatting in textFormatRuns
        runs = cell.get("textFormatRuns", [])
        if not runs:
            return False
        # All runs must be strikethrough
        return all(
            r.get("format", {}).get("strikethrough", False) for r in runs
        )

    # Build owner map from row 0
    owner_map = {}  # owner_name → col_idx
    if row_data:
        vals = row_data[0].get("values", [])
        for col_idx in range(1, len(vals)):
            name = cell_text(vals[col_idx])
            if name:
                owner_map[name] = col_idx

    # Find "Punchlist" row in column A — must be exact match (not "Battery Box Punch List")
    punchlist_row = -1
    for row_idx in range(5, len(row_data)):
        label = cell_text(get_cell(row_idx, 0)).lower()
        if label == "punchlist" or label == "punch list":
            punchlist_row = row_idx
            break

    if punchlist_row < 0:
        return {}

    # Find Item rows after the punchlist header
    item_rows = []
    for row_idx in range(punchlist_row + 1, len(row_data)):
        label = cell_text(get_cell(row_idx, 0)).lower()
        if label.startswith("item"):
            item_rows.append(row_idx)
        elif label:
            break

    if not item_rows:
        return {}

    # Parse punchlist items per vehicle column
    punchlists = {}
    for owner, col_idx in owner_map.items():
        items = []
        for row_idx in item_rows:
            cell = get_cell(row_idx, col_idx)
            text = cell_text(cell)
            if not text:
                continue
            done = is_strikethrough(cell)
            items.append({"text": text, "done": done})

        if items:
            done_count = sum(1 for it in items if it["done"])
            punchlists[owner] = {
                "items": items,
                "total": len(items),
                "done": done_count,
                "open": len(items) - done_count,
            }

    return punchlists


def parse_ampere_overview(service):
    """
    Parse the Ampere 'Vehicles Overview' sheet.

    Layout (columnar, vehicles are columns starting at B):
      Row 0: owner names (col A empty)
      Row 1: years
      Row 2: colors
      Row 3: makes
      Row 4: models
      Row 5: "Checkout Progress" + percentages
      Row 6: "Status" + status values
      Row 7+: Sub-metric rows with labels in col A
    """
    # Fetch enough rows/cols to cover all vehicles and metrics
    rows = fetch_values(service, AMPERE_SHEET_ID, "Vehicles Overview!A1:Z20")
    if not rows:
        return []

    # Build label→row index map from column A
    label_map = {}
    for i, row in enumerate(rows):
        if row and row[0]:
            label_map[str(row[0]).strip()] = i

    checkout_row = label_map.get("Checkout Progress")
    status_row = label_map.get("Status")

    # Find vehicle columns: row 0 has owner names starting at col 1
    owner_row = rows[0] if rows else []
    vehicle_cols = []
    for col_idx in range(1, len(owner_row)):
        name = str(owner_row[col_idx]).strip() if col_idx < len(owner_row) else ""
        if name:
            vehicle_cols.append(col_idx)

    def get_cell(row_idx, col_idx):
        if row_idx is None or row_idx >= len(rows):
            return ""
        row = rows[row_idx]
        if col_idx >= len(row):
            return ""
        return row[col_idx]

    vehicles = []
    for col in vehicle_cols:
        owner = str(get_cell(0, col)).strip()
        if not owner:
            continue

        year_val = get_cell(1, col)
        try:
            year_val = int(float(year_val))
        except (ValueError, TypeError):
            year_val = None

        checkout_val = parse_pct(get_cell(checkout_row, col)) if checkout_row is not None else 0.0
        status_val = str(get_cell(status_row, col)).strip() if status_row is not None else ""

        # Sub-metrics
        sub_metrics = []
        for label in AMPERE_SUB_METRIC_LABELS:
            row_idx = label_map.get(label)
            if row_idx is not None:
                val = parse_pct(get_cell(row_idx, col))
                display = AMPERE_SUB_METRIC_DISPLAY.get(label, label)
                sub_metrics.append({"label": display, "value": val})

        vehicles.append({
            "owner": owner,
            "year": year_val,
            "color": str(get_cell(2, col)).strip(),
            "make": str(get_cell(3, col)).strip(),
            "model": str(get_cell(4, col)).strip(),
            "status": status_val,
            "checkout": checkout_val,
            "sub_metrics": sub_metrics,
            "system": "Ampere",
        })

    return vehicles


def parse_aem_vehicles(service):
    """
    Parse the AEM 'Vehicles' sheet.

    Layout (columnar, vehicles are columns starting at B):
      Row 0: "Vehicle Owner" + owner names
      Row 1: "Vehicle Year" + years
      Row 2: "Vehicle Color" + colors
      Row 3: "Vehicle Make" + makes
      Row 4: "Vehicle Model" + models
      Row 6: "Checkout Progress" + percentages
      Row 7: "Checkout Status" + status values
    All rows have labels in column A.
    """
    rows = fetch_values(service, AEM_SHEET_ID, "Vehicles!A1:Z20")
    if not rows:
        return []

    # Build label→row index map from column A
    label_map = {}
    for i, row in enumerate(rows):
        if row and row[0]:
            label_map[str(row[0]).strip()] = i

    owner_row = label_map.get("Vehicle Owner")
    year_row = label_map.get("Vehicle Year")
    color_row = label_map.get("Vehicle Color")
    make_row = label_map.get("Vehicle Make")
    model_row = label_map.get("Vehicle Model")
    checkout_row = label_map.get("Checkout Progress")
    status_row = label_map.get("Checkout Status")

    if owner_row is None:
        return []

    # Find vehicle columns from the owner row
    owners = rows[owner_row] if owner_row < len(rows) else []
    vehicle_cols = []
    for col_idx in range(1, len(owners)):
        name = str(owners[col_idx]).strip() if col_idx < len(owners) else ""
        if name:
            vehicle_cols.append(col_idx)

    def get_cell(row_idx, col_idx):
        if row_idx is None or row_idx >= len(rows):
            return ""
        row = rows[row_idx]
        if col_idx >= len(row):
            return ""
        return row[col_idx]

    vehicles = []
    for col in vehicle_cols:
        owner = str(get_cell(owner_row, col)).strip()
        if not owner:
            continue

        year_val = get_cell(year_row, col)
        try:
            year_val = int(float(year_val))
        except (ValueError, TypeError):
            year_val = None

        checkout_val = parse_pct(get_cell(checkout_row, col)) if checkout_row is not None else 0.0
        status_val = str(get_cell(status_row, col)).strip() if status_row is not None else ""

        vehicles.append({
            "owner": owner,
            "year": year_val,
            "color": str(get_cell(color_row, col)).strip() if color_row is not None else "",
            "make": str(get_cell(make_row, col)).strip() if make_row is not None else "",
            "model": str(get_cell(model_row, col)).strip() if model_row is not None else "",
            "status": status_val,
            "checkout": checkout_val,
            "sub_metrics": [],
            "system": "AEM",
        })

    return vehicles


def fetch_checkout_data():
    """
    Fetch and merge vehicle checkout data from Ampere and AEM spreadsheets.

    Returns dict with {vehicles, updated, source}.
    """
    service = get_sheets_service()
    all_vehicles = []

    # --- Ampere ---
    print("  Fetching Ampere spreadsheet...")
    try:
        vehicles = parse_ampere_overview(service)
        print(f"    Found {len(vehicles)} Ampere vehicles")

        # Punchlist from Vehicles tab
        punchlists = parse_ampere_punchlist(service)
        pl_count = sum(1 for v in vehicles if v["owner"] in punchlists)
        print(f"    Matched punchlists for {pl_count} vehicles")
        for v in vehicles:
            if v["owner"] in punchlists:
                v["punchlist"] = punchlists[v["owner"]]

        all_vehicles.extend(vehicles)
    except Exception as e:
        print(f"    ERROR fetching Ampere: {e}")

    # --- AEM ---
    print("  Fetching AEM spreadsheet...")
    try:
        vehicles = parse_aem_vehicles(service)
        print(f"    Found {len(vehicles)} AEM vehicles")
        all_vehicles.extend(vehicles)
    except Exception as e:
        print(f"    ERROR fetching AEM: {e}")

    # Sort by checkout progress descending
    all_vehicles.sort(key=lambda v: v.get("checkout", 0), reverse=True)

    return {
        "vehicles": all_vehicles,
        "updated": datetime.now(timezone.utc).isoformat(),
        "source": "Google Sheets API",
    }


if __name__ == "__main__":
    data = fetch_checkout_data()
    print(json.dumps(data, indent=2))
