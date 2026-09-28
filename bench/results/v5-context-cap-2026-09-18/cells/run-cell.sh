#!/bin/bash
# One headless session per size, so nothing accumulates between measurements and each cell is independent.
set -u
ROOT="$HOME/jev-gate-runs/v5-context-cap-1"
MARKER="$1"
CELL="$ROOT/runs/$MARKER"
rm -rf "$CELL"; mkdir -p "$CELL"
export CAP_PROBE_LOG="$CELL/hooks.jsonl"
: > "$CAP_PROBE_LOG"

# The launching session's own Claude variables must not leak into the cell.
for v in $(env | grep -o '^CLAUDE_[A-Z_]*' || true); do unset "$v"; done
export CLAUDE_CODE_FORK_SUBAGENT=0
export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1

PROMPT="Run exactly one search and then stop. Use the Grep tool with pattern \"$MARKER\", output_mode \"content\", and -n true. After the tool returns, reply with only the word DONE. Do not run any other tool and do not summarise the result."

cd "$ROOT/repo" || exit 3
claude -p "$PROMPT" \
  --model sonnet \
  --output-format stream-json --verbose \
  --max-turns 4 \
  --permission-mode acceptEdits \
  --allowedTools Grep \
  --setting-sources project,local \
  --no-session-persistence \
  --plugin-dir "$ROOT/plugin" < /dev/null \
  > "$CELL/stream.jsonl" 2> "$CELL/stderr.txt"
echo "exit=$? marker=$MARKER"
