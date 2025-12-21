#!/usr/bin/env python3
"""
Activate Foreign Currencies in Odoo

Usage:
    export ODOO19_API_KEY="your_api_key"
    python3 scripts/activate-currencies.py
"""

import xmlrpc.client
import os
import sys

ODOO_URL = 'https://acropaq.odoo.com'
ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670'
ODOO_USERNAME = 'nima@acropaq.com'
ODOO_PASSWORD = os.environ.get('ODOO_API_KEY', '9ca1030fd68f798adbab7a84e50e3ae40cba27fd')

if not ODOO_PASSWORD:
    print("ERROR: ODOO19_API_KEY environment variable not set")
    print("Run: export ODOO19_API_KEY='your_api_key'")
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
