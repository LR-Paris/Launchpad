#!/bin/bash
# backfill-shop-builds.sh
# Run once on the server to clear stale .next/ from all shops whose
# built version does not match the source version in package.json.
# After clearing, the container is restarted so it rebuilds from scratch.

SHOPS_DIR="${1:-/root/Launchpad/shops}"

if [ ! -d "$SHOPS_DIR" ]; then
  echo "Shops directory not found: $SHOPS_DIR"
  echo "Usage: $0 [/path/to/Launchpad/shops]"
  exit 1
fi

for shop_dir in "$SHOPS_DIR"/*/; do
  slug=$(basename "$shop_dir")
  pkg="$shop_dir/package.json"
  next_dir="$shop_dir/.next"
  deployed="$next_dir/DEPLOYED_VERSION"

  [ -f "$pkg" ] || continue

  SRC_VER=$(node -e "console.log(require('$pkg').version)" 2>/dev/null)
  BUILT_VER=$(cat "$deployed" 2>/dev/null || echo "unknown")

  if [ "$SRC_VER" != "$BUILT_VER" ]; then
    echo "[$slug] stale: built=$BUILT_VER, src=$SRC_VER — clearing .next/"
    rm -rf "$next_dir"
    (cd "$shop_dir" && docker compose restart)
  else
    echo "[$slug] up to date: $SRC_VER"
  fi
done
