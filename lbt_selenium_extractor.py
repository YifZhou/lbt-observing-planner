#!/usr/bin/env python3
"""
LBT Targets Selenium Extractor
Uses Selenium WebDriver to extract target lists from the LBT queue page
Handles JavaScript-rendered content and form interactions
"""

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import Select
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from urllib.parse import urlparse, parse_qs
import time
import re
from collections import defaultdict
import sys
import json

class LBTTargetsExtractor:
    def __init__(self, headless=True):
        """Initialize the extractor with Chrome WebDriver"""
        
        chrome_options = Options()
        if headless:
            chrome_options.add_argument("--headless")
        chrome_options.add_argument("--no-sandbox")
        chrome_options.add_argument("--disable-dev-shm-usage")
        
        try:
            self.driver = webdriver.Chrome(options=chrome_options)
            self.wait = WebDriverWait(self.driver, 10)
        except Exception as e:
            print(f"Error initializing Chrome WebDriver: {e}")
            print("Make sure ChromeDriver is installed and in your PATH")
            sys.exit(1)
    
    def extract_targets(self, year=2025, month=5, day=30, instruments=None):
        """
        Extract targets for a specific date and instruments
        
        Parameters:
        year (int): Year (2020-2030)
        month (int): Month (1-12) 
        day (int): Day (1-31)
        instruments (list): Instrument names to filter
        
        Returns:
        dict: Targets grouped by instrument
        """
        
        if instruments is None:
            instruments = ['MODS', 'LBC', 'PEPSI', 'LUCI']
        
        url = "https://cgi.astronomy.osu.edu/alt-cgi-bin/Queue/obsqueue.pl"
        
        try:
            print(f"Navigating to {url}")
            self.driver.get(url)
            
            # Wait for page to load
            self.wait.until(EC.presence_of_element_located((By.NAME, "year")))
            
            # Set the date
            print(f"Setting date to {year}-{month:02d}-{day:02d}")
            
            year_select = Select(self.driver.find_element(By.NAME, "year"))
            year_select.select_by_value(str(year))
            
            month_select = Select(self.driver.find_element(By.NAME, "month"))
            month_select.select_by_value(str(month))
            
            day_select = Select(self.driver.find_element(By.NAME, "day"))
            day_select.select_by_value(str(day))

            instrument_select = Select(self.driver.find_element(By.NAME, "instrument"))
            instrument_select.select_by_value('All Instruments')
            
            # Submit the form
            submit_button = self.driver.find_element(By.CSS_SELECTOR, "input[value='Submit Request']")
            submit_button.click()
            
            # Wait for results to load
            self.wait.until(EC.presence_of_element_located((By.TAG_NAME, "table")))
            time.sleep(2)  # Additional wait for complete loading
            
            # Extract targets from all instruments
            all_targets = self._extract_all_targets()
            
            # Filter by requested instruments
            filtered_targets = {}
            for inst in instruments:
                if inst in all_targets:
                    filtered_targets[inst] = all_targets[inst]
            
            return filtered_targets
            
        except Exception as e:
            print(f"Error extracting targets: {e}")
            return {}
    
    def _extract_all_targets(self):
        """Extract all targets from the current page"""
        
        targets_by_instrument = defaultdict(list)
        
        try:
            # Find all tables
            tables = self.driver.find_elements(By.TAG_NAME, "table")
            
            if len(tables) < 2:
                print("Warning: Expected targets table not found")
                return {}
            
            # The targets table is typically the last one
            target_table = tables[-1]
            
            # Get all rows except the header
            rows = target_table.find_elements(By.TAG_NAME, "tr")[1:]
            
            print(f"Found {len(rows)} potential target rows")
            
            for i, row in enumerate(rows):
                try:
                    # Parse the row element directly
                    target_info = self._parse_target_row(row)
                    
                    if target_info:
                        instrument = target_info['instrument']
                        targets_by_instrument[instrument].append(target_info)
                        print(f"Parsed target: {target_info['target_name']} ({instrument}) - Priority: {target_info['priority']}")
                        
                except Exception as e:
                    print(f"Error parsing row {i}: {e}")
                    continue
            
            return dict(targets_by_instrument)
            
        except Exception as e:
            print(f"Error extracting target table: {e}")
            return {}
    
    def _parse_target_row(self, row_element):
        """
        Parse a single target row element to extract information
        
        Parameters:
        row_element: Selenium WebElement of the table row
        
        Returns:
        dict: Target information or None if parsing fails
        """
        
        try:
            # Get all cells (th elements in this case)
            cells = row_element.find_elements(By.TAG_NAME, "th")
            
            if len(cells) < 3:
                return None
            
            # Priority is in the second cell (index 1)
            priority_text = cells[1].text.strip()
            try:
                priority = float(priority_text)
            except (ValueError, TypeError):
                return None
            
            # Object info is in the third cell (index 2)
            object_cell = cells[2]
            object_text = object_cell.text.strip()
            
            # Extract links from the object cell
            links = object_cell.find_elements(By.TAG_NAME, "a")
            readme_link = None
            visibility_link = None
            ra = None
            dec = None
            
            for link in links:
                href = link.get_attribute("href")
                text = link.text.lower()
                
                if "readme" in text:
                    readme_link = href
                elif "visibility" in text:
                    visibility_link = href
                    # Extract coordinates from visibility URL parameters
                    try:
                        parsed_url = urlparse(href)
                        params = parse_qs(parsed_url.query)
                        if 'objRA' in params:
                            ra = params['objRA'][0]
                        if 'objDec' in params:
                            dec = params['objDec'][0]
                    except Exception as e:
                        print(f"Warning: Could not extract coordinates from URL: {e}")
            
            # Parse object text to extract program/target name and instrument
            lines = object_text.split('\n')
            
            # First line should contain the object name
            if not lines:
                return None
            
            object_name = lines[0].strip()
            
            # Look for instrument in subsequent lines
            found_instrument = None
            instruments = ['MODS', 'LBC', 'PEPSI', 'LUCI']
            
            for line in lines[1:]:
                line_upper = line.upper()
                for inst in instruments:
                    if inst in line_upper:
                        found_instrument = inst
                        break
                if found_instrument:
                    break
            
            if not found_instrument:
                return None
            
            # Separate program name and target name
            program_name = 'Unknown'
            target_name = object_name
            
            if '/' in object_name:
                parts = object_name.split('/', 1)
                program_name = parts[0].strip()
                target_name = parts[1].strip()
            
            # Determine photometric conditions from subsequent cells
            phot_condition = 'non-photometric'
            if len(cells) > 3:
                phot_text = cells[3].text.lower()
                if 'phot' in phot_text and 'nonphot' not in phot_text:
                    phot_condition = 'photometric'
            
            # Extract FWHM if available
            fwhm = None
            if len(cells) > 4:
                try:
                    fwhm = float(cells[4].text.strip())
                except (ValueError, TypeError):
                    pass

            duration = None
            if len(cells) > 5:
                try:
                    duration = float(cells[5].text.strip())
                except (ValueError, TypeError):
                    pass
            
            
            return {
                'priority': priority,
                'object': object_name,
                'program_name': program_name,
                'target_name': target_name,
                'instrument': found_instrument,
                'photometric': phot_condition,
                'fwhm': fwhm,
                'duration': duration,
                'readme_link': readme_link,
                'visibility_link': visibility_link,
                'ra': ra,
                'dec': dec,
                'full_text': object_text
            }
            
        except Exception as e:
            print(f"Error parsing target row: {e}")
            return None
    
    def get_available_instruments(self):
        """Get list of available instruments from the page"""
        
        try:
            url = "https://cgi.astronomy.osu.edu/alt-cgi-bin/Queue/obsqueue.pl"
            self.driver.get(url)
            
            # Wait for page to load
            self.wait.until(EC.presence_of_element_located((By.NAME, "instrument")))
            
            # Get instrument dropdown options
            instrument_select = Select(self.driver.find_element(By.NAME, "instrument"))
            instruments = [option.text for option in instrument_select.options if option.text.strip()]
            
            return instruments
            
        except Exception as e:
            print(f"Error getting available instruments: {e}")
            return []
    
    def close(self):
        """Close the WebDriver"""
        if self.driver:
            self.driver.quit()

def download_readme_files(targets_dict, date_str, download_dir=None):
    """
    Download all readme files to a subdirectory
    
    Parameters:
    targets_dict (dict): Dictionary of targets by instrument
    date_str (str): Date string for naming the download directory
    download_dir (str): Optional custom download directory name
    """
    
    import os
    import requests
    from urllib.parse import urlparse
    
    if download_dir is None:
        download_dir = f"readme_files_{date_str.replace('-', '_')}"
    
    # Create download directory
    if not os.path.exists(download_dir):
        os.makedirs(download_dir)
        print(f"Created directory: {download_dir}")
    
    downloaded_files = []
    failed_downloads = []
    
    # Collect all unique readme links
    readme_links = set()
    for instrument, targets in targets_dict.items():
        for target in targets:
            readme_link = target.get('readme_link')
            if readme_link and readme_link != 'Not available':
                readme_links.add((readme_link, target['program_name'], target['target_name'], instrument))
    
    print(f"Found {len(readme_links)} unique readme files to download")
    
    if not readme_links:
        print("No readme files to download")
        return downloaded_files, failed_downloads
    
    # Download each readme file
    for readme_url, program_name, target_name, instrument in readme_links:
        try:
            print(f"Downloading readme for {program_name}/{target_name} ({instrument})...")
            
            # Make request with a reasonable timeout
            response = requests.get(readme_url, timeout=30)
            response.raise_for_status()
            
            # Generate filename
            # Extract original filename from URL or create one
            parsed_url = urlparse(readme_url)
            original_filename = os.path.basename(parsed_url.path)
            
            if not original_filename or original_filename == '/':
                # Create filename from program name and instrument
                safe_program = "".join(c for c in program_name if c.isalnum() or c in ('-', '_'))
                original_filename = f"{safe_program}_{instrument.lower()}_readme.txt"
            
            # Ensure unique filename in case of conflicts
            filename = original_filename
            
            if os.path.exists(os.path.join(download_dir, filename)):
                continue
            
            filepath = os.path.join(download_dir, filename)
            
            # Save the file
            with open(filepath, 'w', encoding='utf-8', errors='replace') as f:
                f.write(response.text)
            
            downloaded_files.append({
                'program_name': program_name,
                'target_name': target_name,
                'instrument': instrument,
                'url': readme_url,
                'filename': filename,
                'filepath': filepath
            })
            
            print(f"  → Saved as: {filename}")
            
        except requests.exceptions.RequestException as e:
            error_msg = f"Failed to download readme for {program_name}/{target_name}: {e}"
            print(f"  → {error_msg}")
            failed_downloads.append({
                'program_name': program_name,
                'target_name': target_name,
                'instrument': instrument,
                'url': readme_url,
                'error': str(e)
            })
            
        except Exception as e:
            error_msg = f"Error saving readme for {program_name}/{target_name}: {e}"
            print(f"  → {error_msg}")
            failed_downloads.append({
                'program_name': program_name,
                'target_name': target_name,
                'instrument': instrument,
                'url': readme_url,
                'error': str(e)
            })
    
    # Create a summary file
    summary_file = os.path.join(download_dir, "download_summary.txt")
    with open(summary_file, 'w', encoding='utf-8') as f:
        f.write(f"README Files Download Summary for {date_str}\n")
        f.write("=" * 50 + "\n\n")
        
        f.write(f"Successfully downloaded: {len(downloaded_files)} files\n")
        f.write(f"Failed downloads: {len(failed_downloads)} files\n\n")
        
        if downloaded_files:
            f.write("SUCCESSFULLY DOWNLOADED FILES:\n")
            f.write("-" * 30 + "\n")
            for file_info in downloaded_files:
                f.write(f"Program: {file_info['program_name']}\n")
                f.write(f"Target: {file_info['target_name']}\n")
                f.write(f"Instrument: {file_info['instrument']}\n")
                f.write(f"Filename: {file_info['filename']}\n")
                f.write(f"URL: {file_info['url']}\n")
                f.write("\n")
        
        if failed_downloads:
            f.write("FAILED DOWNLOADS:\n")
            f.write("-" * 15 + "\n")
            for fail_info in failed_downloads:
                f.write(f"Program: {fail_info['program_name']}\n")
                f.write(f"Target: {fail_info['target_name']}\n")
                f.write(f"Instrument: {fail_info['instrument']}\n")
                f.write(f"URL: {fail_info['url']}\n")
                f.write(f"Error: {fail_info['error']}\n")
                f.write("\n")
    
    print(f"\nDownload Summary:")
    print(f"  Successfully downloaded: {len(downloaded_files)} files")
    print(f"  Failed downloads: {len(failed_downloads)} files")
    print(f"  Files saved to: {download_dir}")
    print(f"  Summary saved to: {summary_file}")
    
    return downloaded_files, failed_downloads

def print_targets(targets_dict, date_str):
    """Print targets organized by instrument"""
    
    print(f"\n=== LBT Targets for {date_str} ===")
    print("Filtered for instruments: MODS, LBC, PEPSI, LUCI")
    print("=" * 50)
    
    total_targets = sum(len(targets) for targets in targets_dict.values())
    
    if total_targets == 0:
        print("No targets found for the specified date and instruments.")
        return
    
    for instrument in ['MODS', 'LBC', 'PEPSI', 'LUCI']:
        if instrument in targets_dict:
            targets = targets_dict[instrument]
            print(f"\n{instrument} ({len(targets)} targets):")
            print("-" * (len(instrument) + 20))
            
            # Sort by priority (lower numbers = higher priority)
            targets.sort(key=lambda x: x['priority'])
            
            for target in targets:
                print(f"  Priority {target['priority']:.1f}: {target['object']}")
                print(f"    Conditions: {target['photometric']}")
                if target.get('fwhm'):
                    print(f"    FWHM: {target['fwhm']} arcsec")
                
    print(f"\nTotal targets: {total_targets}")

def save_to_json(targets_dict, date_str, filename=None):
    """Save targets to a JSON file"""
    
    if filename is None:
        filename = f"lbt_targets_{date_str.replace('-', '_')}.json"
    
    output_data = {
        'date': date_str,
        'instruments_requested': ['MODS', 'LBC', 'PEPSI', 'LUCI'],
        'targets_by_instrument': targets_dict,
        'total_targets': sum(len(targets) for targets in targets_dict.values())
    }
    
    with open(filename, 'w') as f:
        json.dump(output_data, f, indent=2)
    
    print(f"Results saved to: {filename}")

def save_to_text(targets_dict, date_str, filename=None):
    """Save targets to separate CSV files for each instrument"""
    
    import csv
    
    saved_files = []
    
    for instrument in ['MODS', 'LBC', 'PEPSI', 'LUCI']:
        if instrument in targets_dict:
            targets = targets_dict[instrument]
            
            if filename:
                # Use provided filename as base
                base_name = filename.replace('.txt', '').replace('.csv', '')
                csv_filename = f"{base_name}_{instrument}.csv"
            else:
                csv_filename = f"lbt_targets_{date_str.replace('-', '_')}_{instrument}.csv"
            
            # Sort by priority
            targets.sort(key=lambda x: x['priority'], reverse=True)
            
            # Write CSV file
            with open(csv_filename, 'w', newline='', encoding='utf-8') as csvfile:
                fieldnames = ['target_name', 'program_name', 'ra', 'dec', 'priority', 'duration', 'readme_link']
                writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
                
                # Write header
                writer.writeheader()
                
                # Write data
                for target in targets:
                    ra_hhmm = target.get('ra', 'Not available')
                    dec_ddmm = target.get('dec', 'Not available')
                    if (ra_hhmm != 'Not available') and (dec_ddmm != 'Not available'):
                        # Convert RA/Dec to HH:MM and DD:MM format
                        ra_hhmm = '.'.join(ra_hhmm.split(':')[:2])
                        dec_ddmm = '.'.join(dec_ddmm.split(':')[:2])
                    writer.writerow({
                        'target_name': target.get('target_name', 'Unknown'),
                        'program_name': target.get('program_name', 'Unknown'),
                        'ra': ra_hhmm,
                        'dec': dec_ddmm,
                        'priority': target['priority'],
                        'duration': target.get('duration', 'Not available') if target.get('duration') else 'Not available',
                        'readme_link': target.get('readme_link', 'Not available') if target.get('readme_link') else 'Not available'
                    })
            
            saved_files.append(csv_filename)
            print(f"Saved {len(targets)} {instrument} targets to: {csv_filename}")
    
    if saved_files:
        print(f"All results saved to {len(saved_files)} CSV files:")
        for file in saved_files:
            print(f"  - {file}")
    else:
        print("No targets found to save.")

def main():
    """Main function"""
    
    # Default date: May 30, 2025
    year = 2025
    month = 11
    day = 14
    
    # Parse command line arguments if provided
    if len(sys.argv) > 1:
        try:
            date_parts = sys.argv[1].split('-')
            if len(date_parts) == 3:
                year, month, day = map(int, date_parts)
        except ValueError:
            print("Error: Date format should be YYYY-MM-DD")
            print("Usage: python lbt_extractor.py [YYYY-MM-DD]")
            sys.exit(1)
    
    date_str = f"{year}-{month:02d}-{day:02d}"
    
    # Create extractor
    extractor = LBTTargetsExtractor(headless=True)
    
    try:
        # Extract targets
        print("Starting LBT targets extraction...")
        targets = extractor.extract_targets(year, month, day)
        
        # Print results
        print_targets(targets, date_str)
        
        # Save results to CSV files
        save_to_text(targets, date_str)
        save_to_json(targets, date_str)
        
        # Download readme files
        print("\nStarting readme files download...")
        downloaded_files, failed_downloads = download_readme_files(targets, date_str)
        
    except Exception as e:
        print(f"Error during extraction: {e}")
    
    finally:
        # Clean up
        extractor.close()

if __name__ == "__main__":
    main()