#!/usr/bin/env bash
#
# Example: Fetch recent emails via IMAP and POST them to Tower's /ingest endpoint.
#
# This is a reference implementation — adapt to your email provider and auth method.
# Run on a cron schedule (e.g., every 15 minutes) or as a one-shot.
#
# Dependencies: curl, python3 (for IMAP)
#
# Usage:
#   TOWER_URL=http://127.0.0.1:8787 TOWER_TOKEN=<token> \
#   IMAP_HOST=imap.example.com IMAP_USER=you@example.com IMAP_PASS=<pass> \
#   ./email-to-inbox.sh

set -euo pipefail

TOWER_URL="${TOWER_URL:?Set TOWER_URL (e.g., http://127.0.0.1:8787)}"
TOWER_TOKEN="${TOWER_TOKEN:?Set TOWER_TOKEN}"
IMAP_HOST="${IMAP_HOST:?Set IMAP_HOST}"
IMAP_USER="${IMAP_USER:?Set IMAP_USER}"
IMAP_PASS="${IMAP_PASS:?Set IMAP_PASS}"
IMAP_FOLDER="${IMAP_FOLDER:-INBOX}"
MAX_EMAILS="${MAX_EMAILS:-10}"

# Fetch recent unseen emails as JSON array via Python.
emails=$(python3 -c "
import imaplib, email, json, sys

m = imaplib.IMAP4_SSL('${IMAP_HOST}')
m.login('${IMAP_USER}', '${IMAP_PASS}')
m.select('${IMAP_FOLDER}')

_, nums = m.search(None, 'UNSEEN')
ids = nums[0].split()[-${MAX_EMAILS}:]

results = []
for num in ids:
    _, data = m.fetch(num, '(RFC822)')
    msg = email.message_from_bytes(data[0][1])
    body = ''
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == 'text/plain':
                body = part.get_payload(decode=True).decode('utf-8', errors='replace')
                break
    else:
        body = msg.get_payload(decode=True).decode('utf-8', errors='replace')

    results.append({
        'subject': msg.get('Subject', '(no subject)'),
        'from': msg.get('From', 'unknown'),
        'message_id': msg.get('Message-ID', ''),
        'body': body[:10000],
    })

m.logout()
json.dump(results, sys.stdout)
")

echo "$emails" | python3 -c "
import json, sys, subprocess

emails = json.load(sys.stdin)
for e in emails:
    payload = {
        'source': f\"email from {e['from']}\",
        'category': 'emails',
        'title': e['subject'],
        'body': f\"From: {e['from']}\\nSubject: {e['subject']}\\n\\n{e['body']}\",
        'externalId': e['message_id'] or None,
    }
    # Remove None values.
    payload = {k: v for k, v in payload.items() if v is not None}

    result = subprocess.run(
        ['curl', '-s', '-X', 'POST', '${TOWER_URL}/ingest',
         '-H', 'Authorization: Bearer ${TOWER_TOKEN}',
         '-H', 'Content-Type: application/json',
         '-d', json.dumps(payload)],
        capture_output=True, text=True
    )
    r = json.loads(result.stdout) if result.stdout else {}
    status = 'duplicate' if r.get('duplicate') else 'new'
    print(f\"  [{status}] {e['subject'][:60]}\")

print(f'Processed {len(emails)} email(s)')
"
