# LBT Observing Planner

LBT Observing Planner is a local web application for planning and executing observations at the Large Binocular Telescope. It combines OSURC queue scraping, target review, readme inspection, altitude and sky visualization, observing queue management, atmospheric dispersion checks, and status exchange into one browser interface.

The app is designed for observers who need to make fast decisions during a night. It keeps the target table, altitude plot, sky map, readmes, diagnostics, warning flags, and observing sequence in one local interface.

## Features

- Load target lists from OSURC scraper outputs.
- Run the OSURC Selenium scraper from the web app.
- Inspect target readmes and take persistent observer notes.
- Filter, sort, and manually reorder targets.
- Filter targets by status, RA/Dec constraints, and warning flags.
- Plot target altitude over a 14 hour night window centered on LBT midnight.
- Shade civil, nautical, and astronomical twilight from the LBT location.
- Show selected and queued targets in altitude and sky plots.
- Connect queued targets in sky-map order.
- Track an observing sequence with a timeline and cumulative visit time.
- Mark targets todo, observed, or skipped.
- Export and import observing status exchange files.
- Compute atmospheric dispersion and slit alignment diagnostics.

## Repository Contents

```text
lbt_selenium_extractor.py        OSURC queue scraper
lbt_observer_app/server.py       Local HTTP server and data loader
lbt_observer_app/static/         Browser UI
requirements.txt                 Optional scraper dependencies
```

Generated target files, downloaded readmes, local run state, workbook files, and macOS/editor files are ignored by git.

## Installation

Use a standalone environment. Do not install scraper dependencies into a shared system Python.

### Option 1: venv

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

### Option 2: conda

```bash
conda create -n lbt-planner python=3.11
conda activate lbt-planner
python -m pip install -r requirements.txt
```

The local web app itself uses only the Python standard library. The packages in `requirements.txt` are needed for the Selenium scraper:

- `selenium`
- `requests`

Selenium 4.6 and later includes Selenium Manager. In a normal online local environment, Selenium Manager discovers, downloads, and caches the needed browser driver automatically. Manual ChromeDriver installation should not be needed.

On locked-down machines, offline systems, or managed observatory computers, you may still need to preinstall an approved browser and driver through the local system administrator.

## Run Locally

From the repository root:

```bash
python3 lbt_observer_app/server.py --port 8765
```

Then open:

```text
http://127.0.0.1:8765/
```

The app writes local state to:

```text
lbt_observer_app/data/state.json
```

That file is intentionally not tracked by git.

## Typical Workflow

1. Start the local server.
2. Open the app in a browser.
3. Click **Update from OSURC** to run the scraper for the selected date.
4. Use **Refresh local files** if target/readme files were generated outside the app.
5. Select an instrument.
6. Review targets, warnings, altitude curves, sky locations, and readmes.
7. Add targets to the sequence.
8. Use the sequence timeline during the night.
9. Mark observed targets as **Observed**.
10. Export an exchange file when sharing status with collaborators.

## Keyboard Shortcuts

Shortcuts are active only when focus is not in a text field, select menu, or notes box.

```text
Q        Queue or unqueue selected target
D        Mark selected target observed
T        Return selected target to todo
J / Down Select next visible target
K / Up   Select previous visible target
```

## Target Filters

The search box supports plain text and simple RA/Dec constraints:

```text
OSU ra>10 dec<45
ra>=8 ra<14
dec>-5
```

RA constraints are in hours. Dec constraints are in degrees. The comparison precision is intentionally coarse enough for observing decisions.

The **Flags** filter can show targets with any warning, no warning, or specific warning classes such as airmass, Moon, HA, or below-horizon flags.

## Calculations

The planner uses the LBT location by default:

```text
Latitude  = 32.7013 deg
Longitude = -109.8891 deg
Elevation = 3269 m
```

Altitude and hour angle use a sidereal-time calculation and standard spherical astronomy formulae. Airmass uses the Kasten-Young approximation. Moon illumination is computed from the Sun-Moon elongation. Atmospheric dispersion follows the formula used in Prof. Whittle's planner, with the LBT elevation and a fixed 2 C atmosphere assumption.

The Moon warning combines Moon illumination, Moon altitude, and target-Moon separation. If a readme contains a minimum Moon angle requirement in recognizable text, that limit is also used.

## Data Privacy

Do not commit generated target lists, downloaded readmes, exchange files, or local state. These files can contain active program details and observing status. The `.gitignore` file excludes them by default.

## Development Notes

Run a syntax check after editing:

```bash
python3 -m py_compile lbt_observer_app/server.py
node --check lbt_observer_app/static/app.js
```

No build step is required. The server serves static HTML, CSS, and JavaScript directly.
