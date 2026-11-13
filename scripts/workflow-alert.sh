#!/usr/bin/env bash
# Keeps a single open GitHub issue per workflow problem.
#   raise:   comment on the open issue with this title, or open one that
#            mentions the repository owner.
#   resolve: close the open issue with this title, if there is one.
# Usage: bash scripts/workflow-alert.sh raise|resolve "<issue title>" "<what this run did>"
# Env: GH_TOKEN, GH_REPO and RUN_URL; raise also needs OWNER and RUNBOOK_URL.
set -eu
action=${1:-} title=${2:-} note=${3:-}
case "$action" in
  raise|resolve) ;;
  *) echo "usage: workflow-alert.sh raise|resolve <title> <note>" >&2; exit 2 ;;
esac

issue=$(gh issue list --state open --limit 100 --json number,title --jq "[.[] | select(.title == \"$title\") | .number][0] // empty")

if [ "$action" = raise ]; then
  if [ -n "$issue" ]; then
    gh issue comment "$issue" --body "[This run]($RUN_URL) $note"
  else
    gh issue create --title "$title" --body "@$OWNER [this run]($RUN_URL) $note

Start with the [runbook]($RUNBOOK_URL). This issue closes itself after the next healthy run."
  fi
elif [ -n "$issue" ]; then
  gh issue close "$issue" --comment "Healthy again: [this run]($RUN_URL) $note"
fi
