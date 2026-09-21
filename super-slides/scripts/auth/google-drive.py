#!/usr/bin/env python3
"""Mint the proxy's Authorization header for Google Drive from the connected account.

There is no credential to register. The workspace connects a Google account
over OAuth and the engine refreshes that token itself, so this layer only hands
the current access token to the proxy. The apis.json entry lists
`"oauth_providers": ["google"]`, which is what puts OAUTH_GOOGLE_ACCESS_TOKEN in
this script's environment.

WHY THE PROXY AT ALL. An app frame runs at an opaque origin, so a token handed
into the frame is both unnecessary and awkward to keep out of the page. Routing
through the proxy keeps the token server-side and gives the app one auth path.

BOTH DRIVE ROOTS SIT UNDER ONE BASE. The metadata API lives at /drive/v3 and
the upload endpoint at /upload/drive/v3, so the apis.json base_url is the bare
host and the app passes the full path after it.

`expires_in` is a cache lifetime for the minted header, deliberately shorter
than Google's own hour so the engine re-runs this before the token behind it
goes stale. On a 401 the proxy invalidates this layer and re-runs it anyway,
which is what picks up a re-authorized account.
"""
import json
import os
import sys

token = os.environ.get("OAUTH_GOOGLE_ACCESS_TOKEN", "").strip()

if not token:
    print("No Google access token available to the proxy layer.", file=sys.stderr)
    print("Connect a Google account with the drive scope (Settings -> Accounts, "
          "or ask Lucidos to connect Google), then retry.", file=sys.stderr)
    sys.exit(1)

print(json.dumps({
    "headers": {
        "Authorization": f"Bearer {token}",
    },
    "expires_in": 1800,
}))
