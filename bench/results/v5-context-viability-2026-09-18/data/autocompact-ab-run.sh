#!/bin/bash
# One arm of the compaction A/B. Identical work in both arms; the only difference is the auto-compact window.
set -u
R="$HOME/jev-gate-runs/compact-ab"
ARM="$1"; WINDOW="${2:-}"
CELL="$R/runs/$ARM"; rm -rf "$CELL"; mkdir -p "$CELL"
for v in $(env | grep -o '^CLAUDE_[A-Z_]*' || true); do unset "$v"; done
export CLAUDE_CODE_FORK_SUBAGENT=0 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
[ -n "$WINDOW" ] && export CLAUDE_CODE_AUTO_COMPACT_WINDOW="$WINDOW"   # empty = rely on settings.json
PROMPT='You are running a mechanical fixture. data/ holds part01.txt through part60.txt. Run exactly sixty Bash calls, one per file, in filename order: `cat data/partNN.txt`. No loops, no globs, no head, no tail, no pipes, no wc. After each call reply with only the two-digit section number. After the sixtieth reply DONE and stop.'
cd "$R/repo" || exit 3
claude -p "$PROMPT" --model sonnet --output-format stream-json --verbose \
  --max-turns 140 --permission-mode acceptEdits --allowedTools Bash \
  --setting-sources user,project,local < /dev/null > "$CELL/stream.jsonl" 2> "$CELL/err.txt"
echo "$ARM exit=$? window=${WINDOW:-auto}"
