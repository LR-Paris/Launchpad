# How to install this profile README

GitHub shows a profile README from a public repository named after the account.
For this account, that repository is `gi-os/gi-os`.

## Steps

1. Create a public repository named `gi-os` under the `gi-os` account.
2. Copy `README.md` and the `assets/` folder from this directory into the root of that repository.
3. Commit and push to the default branch.
4. Open https://github.com/gi-os to check the result.

```bash
git clone https://github.com/gi-os/gi-os.git
cp -r profile-readme/README.md profile-readme/assets gi-os/
cd gi-os && git add . && git commit -m "Add profile README" && git push
```

## Notes

- The header is two SVG files. GitHub picks one from the reader theme through the `<picture>` element.
- Image paths are relative. Keep `assets/` next to `README.md`.
- To edit the header, run `scripts/gen-header.py` and commit the two files it writes.
