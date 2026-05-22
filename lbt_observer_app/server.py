#!/usr/bin/env python3
"""
Local server for the LBT observing planner.

Usage:
  python3 lbt_observer_app/server.py --port 8765

The server uses only the Python standard library. It serves the static UI,
builds an initial state from the local workbook/readme/scraper files, and
persists observer notes/statuses in lbt_observer_app/data/state.json.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
import zipfile
from dataclasses import dataclass
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse
from xml.etree import ElementTree as ET


APP_DIR = Path(__file__).resolve().parent
ROOT = APP_DIR.parent
STATIC_DIR = APP_DIR / "static"
DATA_DIR = APP_DIR / "data"
STATE_FILE = DATA_DIR / "state.json"
WORKBOOK = ROOT / "Whittle_LBTO_Planner_Nov13_2025.xlsx"
SCRAPER = ROOT / "lbt_selenium_extractor.py"

INSTRUMENT_SHEETS = {"SHARK-V", "MODS", "LUCI", "LBC", "PEPSI", "PEPSI BHB", "PEPSI (2)", "PEPSI Nov 16", "P-POL"}
INSTRUMENT_ORDER = ["MODS", "SHARK-V", "LUCI", "LBC", "PEPSI", "P-POL"]


def utc_stamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def stable_id(*parts: Any) -> str:
    text = "|".join("" if p is None else str(p).strip().lower() for p in parts)
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:14]


def safe_float(value: Any) -> float | None:
    if value in (None, "", "Not available"):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def hms_to_deg(value: Any) -> float | None:
    if value in (None, ""):
        return None
    text = str(value).strip()
    if not text:
        return None
    if ":" in text:
        parts = [safe_float(p) or 0.0 for p in text.split(":")]
        if len(parts) >= 2:
            h = parts[0]
            m = parts[1]
            s = parts[2] if len(parts) > 2 else 0.0
            return 15.0 * (h + m / 60.0 + s / 3600.0)
    x = safe_float(text)
    if x is None:
        return None
    # Workbook convention is h.mm, not decimal hours.
    sign = -1 if x < 0 else 1
    ax = abs(x)
    hour = math.floor(ax)
    minute = round((ax - hour) * 100.0, 8)
    if minute >= 60:
        return sign * 15.0 * ax
    return sign * 15.0 * (hour + minute / 60.0)


def dms_to_deg(value: Any) -> float | None:
    if value in (None, ""):
        return None
    text = str(value).strip()
    if not text:
        return None
    if ":" in text:
        sign = -1 if text.startswith("-") else 1
        clean = text.replace("+", "").replace("-", "")
        parts = [safe_float(p) or 0.0 for p in clean.split(":")]
        if len(parts) >= 2:
            d = parts[0]
            m = parts[1]
            s = parts[2] if len(parts) > 2 else 0.0
            return sign * (d + m / 60.0 + s / 3600.0)
    x = safe_float(text)
    if x is None:
        return None
    sign = -1 if x < 0 else 1
    ax = abs(x)
    deg = math.floor(ax)
    minute = round((ax - deg) * 100.0, 8)
    if minute >= 60:
        return x
    return sign * (deg + minute / 60.0)


def deg_to_hms(ra_deg: float | None) -> str:
    if ra_deg is None:
        return ""
    total_seconds = round(((ra_deg / 15.0) % 24.0) * 3600.0, 1)
    if total_seconds >= 24 * 3600:
        total_seconds -= 24 * 3600
    h = int(total_seconds // 3600)
    m = int((total_seconds % 3600) // 60)
    s = total_seconds - h * 3600 - m * 60
    return f"{h:02d}:{m:02d}:{s:04.1f}"


def deg_to_dms(dec_deg: float | None) -> str:
    if dec_deg is None:
        return ""
    sign = "-" if dec_deg < 0 else "+"
    total_seconds = round(abs(dec_deg) * 3600.0, 1)
    d = int(total_seconds // 3600)
    m = int((total_seconds % 3600) // 60)
    s = total_seconds - d * 3600 - m * 60
    return f"{sign}{d:02d}:{m:02d}:{s:04.1f}"


def normalize_instrument(value: Any) -> str:
    text = (str(value or "")).upper()
    if "LUCI" in text:
        return "LUCI"
    if "LBC" in text:
        return "LBC"
    if "PEPSI" in text:
        return "PEPSI"
    if "MODS" in text:
        return "MODS"
    if "SHARK" in text:
        return "SHARK-V"
    if "P-POL" in text or "PPOL" in text:
        return "P-POL"
    return str(value or "Unknown").strip() or "Unknown"


def derive_partner(program: Any) -> str:
    text = str(program or "").strip()
    if not text:
        return ""
    if "_" in text:
        return text.split("_", 1)[0]
    if "-" in text and text.split("-", 1)[0].isalpha():
        return text.split("-", 1)[0]
    return text


def instrument_sort_key(name: str) -> tuple[int, str]:
    try:
        return (INSTRUMENT_ORDER.index(name), name)
    except ValueError:
        return (99, name)


@dataclass
class XlsxSheet:
    name: str
    path: str


def _xlsx_shared_strings(zf: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    strings: list[str] = []
    for si in root.findall("s:si", ns):
        texts = [t.text or "" for t in si.findall(".//s:t", ns)]
        strings.append("".join(texts))
    return strings


def _xlsx_sheets(zf: zipfile.ZipFile) -> list[XlsxSheet]:
    ns = {
        "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
        "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    }
    wb = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    rel_map = {}
    for rel in rels.findall("rel:Relationship", ns):
        target = rel.attrib.get("Target", "")
        if not target.startswith("/"):
            target = "xl/" + target
        rel_map[rel.attrib["Id"]] = target.lstrip("/")
    out: list[XlsxSheet] = []
    for sheet in wb.findall("m:sheets/m:sheet", ns):
        name = sheet.attrib.get("name", "")
        rid = sheet.attrib.get(f"{{{ns['r']}}}id")
        if rid in rel_map:
            out.append(XlsxSheet(name=name, path=rel_map[rid]))
    return out


def _cell_value(cell: ET.Element, shared: list[str]) -> Any:
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    typ = cell.attrib.get("t")
    value_el = cell.find("m:v", ns)
    inline_el = cell.find("m:is/m:t", ns)
    if inline_el is not None:
        return inline_el.text or ""
    if value_el is None:
        return None
    raw = value_el.text or ""
    if typ == "s":
        idx = int(raw)
        return shared[idx] if 0 <= idx < len(shared) else ""
    if typ == "b":
        return raw == "1"
    try:
        num = float(raw)
        return int(num) if num.is_integer() else num
    except ValueError:
        return raw


def read_xlsx_targets(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    targets: list[dict[str, Any]] = []
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(path) as zf:
        shared = _xlsx_shared_strings(zf)
        for sheet in _xlsx_sheets(zf):
            if sheet.name not in INSTRUMENT_SHEETS:
                continue
            instrument = normalize_instrument(sheet.name)
            root = ET.fromstring(zf.read(sheet.path))
            rows: dict[int, dict[str, Any]] = {}
            for c in root.findall(".//m:c", ns):
                ref = c.attrib.get("r", "")
                m = re.match(r"([A-Z]+)([0-9]+)", ref)
                if not m:
                    continue
                col, row_text = m.group(1), m.group(2)
                row = int(row_text)
                if row < 5 or row > 200:
                    continue
                if col not in {"V", "W", "X", "Y", "Z", "AA", "AB", "AC", "AD"}:
                    continue
                rows.setdefault(row, {})[col] = _cell_value(c, shared)
            for row, vals in sorted(rows.items()):
                name = str(vals.get("W") or "").strip()
                if not name or name.lower() in {"moon", "target name"}:
                    continue
                ra_deg = hms_to_deg(vals.get("AA"))
                dec_deg = dms_to_deg(vals.get("AB"))
                if ra_deg is None or dec_deg is None:
                    continue
                target = {
                    "id": stable_id("xlsx", sheet.name, name, vals.get("AA"), vals.get("AB")),
                    "source": "workbook",
                    "sourceSheet": sheet.name,
                    "instrument": instrument,
                    "displayInstrument": sheet.name,
                    "targetName": name,
                    "programName": str(vals.get("X") or "").strip(),
                    "partner": str(vals.get("X") or "").strip(),
                    "priority": safe_float(vals.get("Y")),
                    "status": str(vals.get("Z") or "").strip().lower(),
                    "raDeg": ra_deg,
                    "decDeg": dec_deg,
                    "raText": deg_to_hms(ra_deg),
                    "decText": deg_to_dms(dec_deg),
                    "visitHours": safe_float(vals.get("AC")),
                    "haLimitHours": safe_float(vals.get("AD")),
                    "notes": "",
                    "readmeId": "",
                    "observedAt": "",
                }
                targets.append(target)
    return targets


def parse_readme(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8", errors="replace")
    compact = text.replace("\r\n", "\n")

    def first(pattern: str) -> str:
        m = re.search(pattern, compact, re.MULTILINE | re.IGNORECASE)
        return m.group(1).strip() if m else ""

    project = first(r"^\s*Project ID:\s*(.+)$")
    title = first(r"^\s*Title:\s*(.+)$")
    instrument_raw = first(r"^\s*Instrument:\s*(.+)$")
    partner = first(r"^\s*Partner:\s*(.+)$")
    pi = first(r"^\s*PI:\s*(.+)$")
    if not pi:
        m = re.search(r"^\s*PI:\s*\n\s*(.+)$", compact, re.MULTILINE | re.IGNORECASE)
        pi = m.group(1).strip() if m else ""
    conditions = ""
    m = re.search(r"Conditions Required:\s*(.*?)(?:\n\s*\n[A-Z][A-Za-z ]+:|\n[-]{4,}|\Z)", compact, re.S | re.I)
    if m:
        conditions = re.sub(r"\n\s+", "\n", m.group(1).strip())
    instructions = ""
    m = re.search(r"(?:Observing Instructions|Instructions):\s*(.*?)(?:\n\s*(?:Calibrations|Finding Charts|Special Instructions|Manifest):|\Z)", compact, re.S | re.I)
    if m:
        instructions = re.sub(r"\n{3,}", "\n\n", m.group(1).strip())

    instrument = normalize_instrument(instrument_raw or path.name)
    rid = stable_id("readme", path.name, project, instrument)
    return {
        "id": rid,
        "filename": path.name,
        "path": str(path.relative_to(ROOT)),
        "projectId": project,
        "title": title,
        "instrument": instrument,
        "instrumentRaw": instrument_raw,
        "partner": partner,
        "pi": pi,
        "conditions": conditions,
        "instructions": instructions,
        "text": compact,
    }


def read_readmes() -> list[dict[str, Any]]:
    files: list[Path] = []
    for directory in [ROOT / "Example_Readmes", *ROOT.glob("readme_files_*")]:
        if directory.exists() and directory.is_dir():
            files.extend(sorted(directory.glob("*.readme")))
            files.extend(sorted(directory.glob("*.txt")))
    seen: set[Path] = set()
    readmes_by_file: dict[tuple[str, str], dict[str, Any]] = {}
    for path in files:
        if path.name == "download_summary.txt" or path in seen:
            continue
        seen.add(path)
        readme = parse_readme(path)
        file_key = (readme.get("filename", "").lower(), readme.get("instrument", ""))
        if should_replace_readme(readmes_by_file.get(file_key), readme):
            readmes_by_file[file_key] = readme
    return sorted(readmes_by_file.values(), key=lambda r: (instrument_sort_key(r.get("instrument", "")), r.get("projectId") or r.get("filename") or ""))


def should_replace_readme(current: dict[str, Any] | None, candidate: dict[str, Any]) -> bool:
    if current is None:
        return True
    current_is_example = str(current.get("path", "")).startswith("Example_Readmes/")
    candidate_is_example = str(candidate.get("path", "")).startswith("Example_Readmes/")
    if current_is_example != candidate_is_example:
        return current_is_example and not candidate_is_example
    current_rank = source_rank(current.get("path", ""))
    candidate_rank = source_rank(candidate.get("path", ""))
    if candidate_rank != current_rank:
        return candidate_rank > current_rank
    return len(candidate.get("text", "")) > len(current.get("text", ""))


def source_rank(value: Any) -> tuple[int, str]:
    text = str(value or "")
    if text.startswith("Example_Readmes/"):
        return (0, "")
    m = re.search(r"(\d{4})_(\d{2})_(\d{2})", text)
    if m:
        return (2, "".join(m.groups()))
    return (1, text)


def read_targets_from_scraper_files() -> list[dict[str, Any]]:
    targets: list[dict[str, Any]] = []
    for path in sorted(ROOT.glob("lbt_targets_*.json")):
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError:
            continue
        for instrument, rows in (data.get("targets_by_instrument") or {}).items():
            for row in rows:
                targets.append(scraper_row_to_target(row, instrument, f"json:{path.name}"))
    for path in sorted(ROOT.glob("lbt_targets_*_*.csv")):
        instrument = path.stem.split("_")[-1].upper()
        with path.open(newline="", encoding="utf-8", errors="replace") as fh:
            for row in csv.DictReader(fh):
                targets.append(scraper_row_to_target(row, instrument, f"csv:{path.name}"))
    return targets


def scraper_row_to_target(row: dict[str, Any], instrument_hint: str, source: str) -> dict[str, Any]:
    ra_deg = hms_to_deg(row.get("ra") or row.get("RA"))
    dec_deg = dms_to_deg(row.get("dec") or row.get("Dec"))
    instrument = normalize_instrument(row.get("instrument") or instrument_hint)
    name = row.get("target_name") or row.get("targetName") or row.get("object") or "Unknown"
    program = row.get("program_name") or row.get("programName") or ""
    partner = row.get("partner") or row.get("Partner") or derive_partner(program)
    duration = safe_float(row.get("duration"))
    visit = duration / 60.0 if duration and duration > 10 else duration
    return {
        "id": stable_id(source, instrument, name, ra_deg, dec_deg),
        "source": source,
        "sourceSheet": "",
        "instrument": instrument,
        "displayInstrument": instrument,
        "targetName": str(name).strip(),
        "programName": str(program).strip(),
        "partner": str(partner).strip(),
        "priority": safe_float(row.get("priority")),
        "status": "",
        "raDeg": ra_deg,
        "decDeg": dec_deg,
        "raText": deg_to_hms(ra_deg),
        "decText": deg_to_dms(dec_deg),
        "visitHours": visit,
        "haLimitHours": None,
        "notes": "",
        "readmeId": "",
        "readmeLink": row.get("readme_link") or row.get("readmeLink") or "",
        "visibilityLink": row.get("visibility_link") or row.get("visibilityLink") or "",
        "photometric": row.get("photometric") or "",
        "fwhm": safe_float(row.get("fwhm")),
        "observedAt": "",
    }


def attach_readmes(targets: list[dict[str, Any]], readmes: list[dict[str, Any]]) -> None:
    by_inst: dict[str, list[dict[str, Any]]] = {}
    for readme in readmes:
        by_inst.setdefault(readme["instrument"], []).append(readme)
    for target in targets:
        if target.get("readmeId"):
            continue
        candidates = by_inst.get(target.get("instrument"), [])
        program = (target.get("programName") or "").lower()
        name = (target.get("targetName") or "").lower()
        best = None
        for readme in candidates:
            blob = " ".join([readme.get("filename", ""), readme.get("projectId", ""), readme.get("title", "")]).lower()
            text_blob = (blob + " " + readme.get("text", "")).lower()
            if program and token_match(program, blob if len(program) < 3 else text_blob):
                best = readme
                break
            if name and token_match(name, text_blob):
                best = readme
                break
        if best:
            target["readmeId"] = best["id"]
            if best.get("partner") and (not target.get("partner") or target.get("partner") == target.get("programName")):
                target["partner"] = best["partner"]
        if not target.get("partner") or target.get("partner") == target.get("programName"):
            target["partner"] = derive_partner(target.get("programName"))


def token_match(needle: str, haystack: str) -> bool:
    clean = (needle or "").strip().lower()
    if not clean:
        return False
    return re.search(rf"(^|[^a-z0-9]){re.escape(clean)}([^a-z0-9]|$)", haystack, re.I) is not None


def merge_targets(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_key: dict[tuple[str, str, str], dict[str, Any]] = {}
    for group in groups:
        for target in group:
            key = target_identity(target)
            current = by_key.get(key)
            if current is None or source_rank(target.get("source", "")) >= source_rank(current.get("source", "")):
                by_key[key] = target
    return list(by_key.values())


def target_identity(target: dict[str, Any]) -> tuple[str, str, str]:
    return (
        normalize_instrument(target.get("instrument")),
        str(target.get("targetName", "")).strip().lower(),
        str(round(target.get("raDeg") or -999.0, 4)),
    )


def readme_identity(readme: dict[str, Any]) -> tuple[str, str]:
    return (
        str(readme.get("filename") or "").strip().lower(),
        normalize_instrument(readme.get("instrument")),
    )


def build_initial_state() -> dict[str, Any]:
    readmes = read_readmes()
    # Do not silently seed the live planner from the Excel workbook.
    # The workbook parser is kept for future import support, but the default
    # observing target list should reflect OSURC scraper output only.
    targets = merge_targets(read_targets_from_scraper_files())
    attach_readmes(targets, readmes)
    target_instruments = sorted({t["instrument"] for t in targets}, key=instrument_sort_key)
    instruments = sorted(set(target_instruments) | {r["instrument"] for r in readmes}, key=instrument_sort_key)
    return {
        "version": 1,
        "updatedAt": utc_stamp(),
        "meta": {
            "siteName": "Large Binocular Telescope",
            "latitudeDeg": 32.7013,
            "longitudeDeg": -109.8891,
            "elevationM": 3269,
            "date": time.strftime("%Y-%m-%d", time.gmtime()),
            "timezone": "UTC",
            "selectedLocalTime": time.strftime("%Y-%m-%dT%H:%M", time.gmtime()),
            "activeInstrument": target_instruments[0] if target_instruments else (instruments[0] if instruments else "PEPSI"),
        },
        "targets": targets,
        "readmes": readmes,
        "sequence": [],
    }


def carry_observer_state(new_state: dict[str, Any], old_state: dict[str, Any]) -> dict[str, Any]:
    if not old_state:
        return new_state
    old_meta = old_state.get("meta") or {}
    new_meta = new_state.setdefault("meta", {})
    for key in [
        "date", "timezone", "selectedLocalTime", "activeInstrument", "activeView",
        "sortKey", "sortDir", "atm", "activeReadmeId",
    ]:
        if key in old_meta:
            new_meta[key] = old_meta[key]

    old_targets_by_id = {t.get("id"): t for t in old_state.get("targets", []) if t.get("id")}
    old_targets_by_key = {target_identity(t): t for t in old_state.get("targets", [])}
    id_map: dict[str, str] = {}
    for target in new_state.get("targets", []):
        old = old_targets_by_id.get(target.get("id")) or old_targets_by_key.get(target_identity(target))
        if not old:
            continue
        if old.get("id") and target.get("id"):
            id_map[old["id"]] = target["id"]
        for key in ["status", "notes", "observedAt", "priority", "manualOrder", "readmeId"]:
            if key in old and old.get(key) not in (None, ""):
                target[key] = old[key]

    old_sequence = old_state.get("sequence") or []
    new_target_ids = {t.get("id") for t in new_state.get("targets", [])}
    new_sequence = []
    for old_id in old_sequence:
        new_id = id_map.get(old_id, old_id)
        if new_id in new_target_ids and new_id not in new_sequence:
            new_sequence.append(new_id)
    new_state["sequence"] = new_sequence

    old_readmes_by_id = {r.get("id"): r for r in old_state.get("readmes", []) if r.get("id")}
    old_readmes_by_key = {readme_identity(r): r for r in old_state.get("readmes", [])}
    readme_id_map: dict[str, str] = {}
    for readme in new_state.get("readmes", []):
        old = old_readmes_by_id.get(readme.get("id")) or old_readmes_by_key.get(readme_identity(readme))
        if old and old.get("id") and readme.get("id"):
            readme_id_map[old["id"]] = readme["id"]
    if readme_id_map:
        for target in new_state.get("targets", []):
            if target.get("readmeId") in readme_id_map:
                target["readmeId"] = readme_id_map[target["readmeId"]]

    old_notes = old_state.get("readmeNotes") or {}
    if old_notes:
        new_notes = dict(new_state.get("readmeNotes") or {})
        for old_id, note in old_notes.items():
            new_notes[readme_id_map.get(old_id, old_id)] = note
        new_state["readmeNotes"] = new_notes
    if old_meta.get("activeReadmeId"):
        new_meta["activeReadmeId"] = readme_id_map.get(old_meta["activeReadmeId"], old_meta["activeReadmeId"])
    return new_state


def load_state() -> dict[str, Any]:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except json.JSONDecodeError:
            pass
    state = build_initial_state()
    save_state(state)
    return state


def save_state(state: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    state["updatedAt"] = utc_stamp()
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    tmp.replace(STATE_FILE)


class Handler(SimpleHTTPRequestHandler):
    server_version = "LBTPlanner/0.1"

    def translate_path(self, path: str) -> str:
        parsed = urlparse(path)
        if parsed.path == "/":
            return str(STATIC_DIR / "index.html")
        if parsed.path.startswith("/static/"):
            return str(STATIC_DIR / parsed.path.removeprefix("/static/"))
        return str(STATIC_DIR / parsed.path.lstrip("/"))

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, data: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            self.send_json(load_state())
            return
        if parsed.path == "/api/rebuild":
            old_state = load_state()
            state = build_initial_state()
            state = carry_observer_state(state, old_state)
            save_state(state)
            self.send_json(state)
            return
        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            state = self.read_json()
            save_state(state)
            self.send_json({"ok": True, "updatedAt": state["updatedAt"]})
            return
        if parsed.path == "/api/run-scraper":
            payload = self.read_json()
            date = str(payload.get("date") or "").strip()
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
                self.send_json({"ok": False, "error": "Expected date YYYY-MM-DD"}, HTTPStatus.BAD_REQUEST)
                return
            if not SCRAPER.exists():
                self.send_json({"ok": False, "error": "lbt_selenium_extractor.py not found"}, HTTPStatus.NOT_FOUND)
                return
            try:
                result = subprocess.run(
                    [sys.executable, str(SCRAPER), date],
                    cwd=str(ROOT),
                    capture_output=True,
                    text=True,
                    timeout=600,
                )
            except Exception as exc:
                self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)
                return
            old_state = load_state()
            state = build_initial_state()
            state = carry_observer_state(state, old_state)
            save_state(state)
            self.send_json({
                "ok": result.returncode == 0,
                "returncode": result.returncode,
                "stdout": result.stdout[-12000:],
                "stderr": result.stderr[-12000:],
                "state": state,
            })
            return
        self.send_json({"ok": False, "error": "Unknown endpoint"}, HTTPStatus.NOT_FOUND)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    DATA_DIR.mkdir(exist_ok=True)
    load_state()
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"LBT observing planner: http://127.0.0.1:{args.port}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
