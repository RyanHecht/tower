#!/usr/bin/env bash
# Bearer token management. Stores sha256 hashes only; plaintext tokens are
# printed once at mint time and never persisted.
#
# Usage:
#   token.sh mint <label>      # mint a new token, print it once
#   token.sh list              # list non-revoked tokens (id, label, last used)
#   token.sh revoke <id>       # revoke a token by id
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/data"
STORE="$ROOT/data/tokens.json"
[[ -f "$STORE" ]] || echo '{"tokens":[]}' > "$STORE"

cmd="${1:-help}"
shift || true

case "$cmd" in
  mint)
    label="${1:-}"
    if [[ -z "$label" ]]; then echo "usage: token.sh mint <label>" >&2; exit 2; fi
    token="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
    id="$(head -c 6 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
    hash="$(printf %s "$token" | sha256sum | cut -d' ' -f1)"
    created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    node --input-type=module - "$STORE" "$id" "$label" "$hash" "$created" <<'JS'
      import fs from "node:fs";
      const [,, file, id, label, hash, createdAt] = process.argv;
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      data.tokens.push({ id, label, hash, createdAt, lastUsedAt: null, revokedAt: null });
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
JS
    chmod 600 "$STORE"
    echo "minted token id=$id label=$label"
    echo
    echo "  $token"
    echo
    echo "(this is the only time it will be shown — copy it now)"
    ;;
  list)
    node --input-type=module - "$STORE" <<'JS'
      import fs from "node:fs";
      const [,, file] = process.argv;
      const { tokens } = JSON.parse(fs.readFileSync(file, "utf8"));
      const live = tokens.filter(t => !t.revokedAt);
      if (live.length === 0) { console.log("(no live tokens)"); process.exit(0); }
      const w = (s, n) => String(s ?? "").padEnd(n);
      console.log(w("id", 12) + w("label", 24) + w("created", 22) + "lastUsed");
      for (const t of live) console.log(w(t.id,12) + w(t.label,24) + w(t.createdAt,22) + (t.lastUsedAt ?? "-"));
JS
    ;;
  revoke)
    id="${1:-}"
    if [[ -z "$id" ]]; then echo "usage: token.sh revoke <id>" >&2; exit 2; fi
    revoked="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    node --input-type=module - "$STORE" "$id" "$revoked" <<'JS'
      import fs from "node:fs";
      const [,, file, id, revokedAt] = process.argv;
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const t = data.tokens.find(x => x.id === id);
      if (!t) { console.error(`no token with id=${id}`); process.exit(1); }
      if (t.revokedAt) { console.error(`token ${id} already revoked`); process.exit(0); }
      t.revokedAt = revokedAt;
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
      console.log(`revoked ${id}`);
JS
    ;;
  *)
    cat <<EOF
usage:
  token.sh mint <label>     mint a new token (printed once)
  token.sh list             list live tokens
  token.sh revoke <id>      revoke a token
EOF
    exit 2
    ;;
esac
