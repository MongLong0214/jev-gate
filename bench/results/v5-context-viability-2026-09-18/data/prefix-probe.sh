#!/bin/bash
# One-turn session: all we want is the turn-1 prompt size, which is the static prefix.
set -u
R="$HOME/jev-gate-runs/prefix"; NAME="$1"; shift
CELL="$R/runs/$NAME"; rm -rf "$CELL"; mkdir -p "$CELL"
for v in $(env | grep -o '^CLAUDE_[A-Z_]*' || true); do unset "$v"; done
cd "$R/repo" || exit 3
claude -p 'Reply with exactly: OK' --model sonnet --output-format stream-json --verbose \
  --max-turns 2 --permission-mode acceptEdits "$@" < /dev/null > "$CELL/stream.jsonl" 2> "$CELL/err.txt"
python3 -c "
import json,sys
first=None
for line in open('$CELL/stream.jsonl',encoding='utf-8'):
    try: e=json.loads(line)
    except: continue
    u=(e.get('message') or {}).get('usage')
    if u: first=u.get('cache_read_input_tokens',0)+u.get('cache_creation_input_tokens',0)+u.get('input_tokens',0); break
print(f'$NAME\t{first}')
"
