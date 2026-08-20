#!/usr/bin/env bash
# Fill in the missing repository descriptions on github.com/gi-os.
#
# Requires the GitHub CLI, authenticated as gi-os:  gh auth login
# Run:  bash scripts/set-repo-descriptions.sh          (dry run, prints the plan)
#       bash scripts/set-repo-descriptions.sh --apply  (writes the changes)
#
# A repository that already has a description is skipped, except for the ones
# listed under REWRITE, which are replaced on purpose.

set -u
APPLY=${1:-}
OWNER=gi-os

# repo|description  — these repos have no description today
NEW=(
  "gi-os|The README behind github.com/gi-os"
  "BrightRecorder|Voice recorder for the Light Phone III"
  "BrightSudoku|Sudoku for the Light Phone III"
  "Gi-OS6|Gi-OS version 6"
  "June4-Online|June Virtual Secretary version 4, on the web"
)

# repo|description  — replaced even though a description exists
REWRITE=(
  "gzldev|Personal site: projects, bookshelf, film log, photographs"
)

# Repos with no description that need one from you. Fill in the text, move the
# line into NEW, and run again. Left blank on purpose rather than guessed.
TODO=(
  "TeslaHUD"
  "Clout"
  "WeebBase"
  "Galileo"
)

set_description() {
  local repo=$1 desc=$2 force=$3 current
  current=$(gh repo view "$OWNER/$repo" --json description -q .description 2>/dev/null) || {
    echo "  skip  $repo (cannot read, check access)"; return; }
  if [ -n "$current" ] && [ "$force" != force ]; then
    echo "  skip  $repo (already: $current)"; return
  fi
  if [ "$APPLY" = "--apply" ]; then
    gh repo edit "$OWNER/$repo" --description "$desc" >/dev/null && echo "  set   $repo -> $desc"
  else
    echo "  would set  $repo -> $desc"
  fi
}

echo "Missing descriptions:"
for entry in "${NEW[@]}"; do set_description "${entry%%|*}" "${entry#*|}" no; done

echo
echo "Rewrites:"
for entry in "${REWRITE[@]}"; do set_description "${entry%%|*}" "${entry#*|}" force; done

echo
echo "Still need text from you: ${TODO[*]}"
[ "$APPLY" = "--apply" ] || echo "
Dry run. Re-run with --apply to write the changes."
