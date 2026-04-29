#!/usr/bin/env bash
#
# Example: Fetch RSS feed entries and POST them to Tower's /ingest endpoint.
#
# Dependencies: curl, python3 (with feedparser: pip install feedparser)
#
# Usage:
#   TOWER_URL=http://127.0.0.1:8787 TOWER_TOKEN=<token> \
#   FEED_URL=https://example.com/feed.xml \
#   ./rss-to-inbox.sh

set -euo pipefail

TOWER_URL="${TOWER_URL:?Set TOWER_URL (e.g., http://127.0.0.1:8787)}"
TOWER_TOKEN="${TOWER_TOKEN:?Set TOWER_TOKEN}"
FEED_URL="${FEED_URL:?Set FEED_URL}"
MAX_ENTRIES="${MAX_ENTRIES:-10}"

python3 -c "
import feedparser, json, subprocess, sys

feed = feedparser.parse('${FEED_URL}')
entries = feed.entries[:${MAX_ENTRIES}]

for entry in entries:
    payload = {
        'source': f'rss: {feed.feed.get(\"title\", \"unknown\")}',
        'category': 'articles',
        'title': entry.get('title', 'Untitled'),
        'body': f'# {entry.get(\"title\", \"Untitled\")}\n\nLink: {entry.get(\"link\", \"\")}\n\n{entry.get(\"summary\", \"\")}',
        'externalId': entry.get('id') or entry.get('link', ''),
    }
    payload = {k: v for k, v in payload.items() if v}

    result = subprocess.run(
        ['curl', '-s', '-X', 'POST', '${TOWER_URL}/ingest',
         '-H', 'Authorization: Bearer ${TOWER_TOKEN}',
         '-H', 'Content-Type: application/json',
         '-d', json.dumps(payload)],
        capture_output=True, text=True
    )
    r = json.loads(result.stdout) if result.stdout else {}
    status = 'duplicate' if r.get('duplicate') else 'new'
    print(f'  [{status}] {entry.get(\"title\", \"?\")[:60]}')

print(f'Processed {len(entries)} entries from {feed.feed.get(\"title\", \"unknown\")}')
"
