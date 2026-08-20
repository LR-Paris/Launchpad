# How to install this profile README

GitHub shows a profile README from a public repository named after the account.
For this account, that repository is `gi-os/gi-os`.

The README is one file. The header is ASCII art inside a code block, so there
are no images to upload and nothing to break.

## Steps

1. Copy `README.md` into the root of `gi-os/gi-os`.
2. Delete the `assets/` folder in that repository. The README no longer uses it.
3. Commit to the default branch.
4. Open https://github.com/gi-os to check the result.

```bash
git clone https://github.com/gi-os/gi-os.git
cp profile-readme/README.md gi-os/README.md
cd gi-os && git rm -r assets
git add . && git commit -m "Profile README" && git push
```

## The header art

`scripts/art-source.txt` holds the portrait from gzl.dev, 120 columns wide.
`scripts/make-header.py` resamples it to any width and corrects for the shape of
a monospace character cell, which is taller than it is wide.

```bash
cd profile-readme
python3 scripts/make-header.py 100    # the width used in README.md
python3 scripts/make-header.py 80     # smaller, for a shorter page
```

Paste the output at the top of `README.md`, inside the first code fence, above
the two caption lines.

## Repository descriptions

`scripts/set-repo-descriptions.sh` fills in the repositories that have no
description. It needs the GitHub CLI, authenticated as gi-os.

```bash
bash scripts/set-repo-descriptions.sh            # dry run
bash scripts/set-repo-descriptions.sh --apply    # write the changes
```
