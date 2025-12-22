#!/usr/bin/env python3
"""
Activate Foreign Currencies in Odoo

Usage:
    Reads credentials from .env file via dotenv
    python3 scripts/activate-currencies.py
"""

import xmlrpc.client
import os
import sys
from pathlib import Path

# Load .env file
env_path = Path(__file__).parent.parent / '.env'
if env_path.exists():
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                os.environ.setdefault(key.strip(), value.strip())

ODOO_URL = os.environ.get('ODOO_URL', 'https://acropaq.odoo.com')
ODOO_DB = os.environ.get('ODOO_DB')
ODOO_USERNAME = os.environ.get('ODOO_USERNAME')  # Should be info@acropaq.com
ODOO_PASSWORD = os.environ.get('ODOO_PASSWORD') or os.environ.get('ODOO_API_KEY')

if not ODOO_DB or not ODOO_USERNAME or not ODOO_PASSWORD:
    print("ERROR: Missing Odoo credentials in .env file!")
    print("Required: ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD")
    sys.exit(1)

# Currencies to ensure are active
CURRENCIES_NEEDED = [
    'GBP',  # British Pound - for UK sales
    'PLN',  # Polish Zloty - for Poland
    'CZK',  # Czech Koruna - for Czech Republic
    'SEK',  # Swedish Krona - for Sweden
    'DKK',  # Danish Krone - for Denmark
    'HUF',  # Hungarian Forint - for Hungary
    'RON',  # Romanian Leu - for Romania
    'BGN',  # Bulgarian Lev - for Bulgaria
]

def main():
    print("Connecting to Odoo...")
    common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
    uid = common.authenticate(ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {})

    if not uid:
        print("ERROR: Authentication failed")
        sys.exit(1)

    models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')
    print(f"Connected as user ID: {uid}")

    print("\n=== ACTIVATING CURRENCIES ===")

    activated = []
    already_active = []
    not_found = []

    for code in CURRENCIES_NEEDED:
        # Search with active_test=False to find inactive currencies
        found = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'res.currency', 'search_read',
            [[['name', '=', code]]],
            {'fields': ['id', 'name', 'symbol', 'active', 'rate'], 'context': {'active_test': False}}
        )

        if found:
            c = found[0]
            if c['active']:
                already_active.append(f"{code} ({c.get('symbol', '')})")
                print(f"  {code}: Already active ✓")
            else:
                # Activate it
                models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'res.currency', 'write',
                    [[c['id']], {'active': True}]
                )
                activated.append(f"{code} ({c.get('symbol', '')})")
                print(f"  {code}: Activated ✓")
        else:
            not_found.append(code)
            print(f"  {code}: NOT FOUND in database ✗")

    print("\n=== SUMMARY ===")
    print(f"Already active: {len(already_active)}")
    for c in already_active:
        print(f"  - {c}")

    print(f"Newly activated: {len(activated)}")
    for c in activated:
        print(f"  - {c}")

    if not_found:
        print(f"Not found (need to create manually): {len(not_found)}")
        for c in not_found:
            print(f"  - {c}")

    # Verify final state
    print("\n=== VERIFICATION ===")
    for code in CURRENCIES_NEEDED:
        found = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'res.currency', 'search_read',
            [[['name', '=', code], ['active', '=', True]]],
            {'fields': ['id', 'name', 'symbol', 'rate']}
        )
        if found:
            c = found[0]
            print(f"  {code} ({c.get('symbol', '')}): ✓ Active - Rate: {c.get('rate', 'N/A')}")
        else:
            print(f"  {code}: ✗ Not active or not found")

    print("\nDone!")

if __name__ == '__main__':
    main()
