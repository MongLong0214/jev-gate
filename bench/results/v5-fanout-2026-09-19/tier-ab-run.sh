#!/bin/bash
# Same task, same fixture, one model each. The checker decides whether the cheaper tier actually did the work.
set -u
R="$HOME/jev-gate-runs/tier-test"; M="$1"
W="$R/work-$M"; rm -rf "$W"; mkdir -p "$W"
cp -R "$HOME/projects/jev-gate/bench/fixtures/wide-validators/." "$W/"
for v in $(env | grep -o '^CLAUDE_[A-Z_]*' || true); do unset "$v"; done
export CLAUDE_CODE_FORK_SUBAGENT=0 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
cd "$W" || exit 3
claude -p "$(cat "$R/task.txt")" --model "$M" --output-format stream-json --verbose \
  --max-turns 60 --permission-mode acceptEdits --allowedTools Bash,Read,Edit,Write \
  --setting-sources project,local < /dev/null > "$R/stream-$M.jsonl" 2> "$R/err-$M.txt"
echo "$M exit=$?"
