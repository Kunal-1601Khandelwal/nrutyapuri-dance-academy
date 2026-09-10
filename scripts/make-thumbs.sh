#!/bin/sh
# Creates the 240px thumbnails the gallery uses (media/thumbs/<same basename as media/photos/>).
# The strip and the blurred slide backdrops read them; the CMS does not generate them, so run this
# after adding photos and commit media/thumbs/ together with the photos. Only missing thumbs are created.
# Requires macOS `sips`.
cd "$(dirname "$0")/.." || exit 1
mkdir -p media/thumbs
made=0
for f in media/photos/*; do
  [ -f "$f" ] || continue
  t="media/thumbs/$(basename "$f")"
  [ -e "$t" ] && continue
  case "$f" in
    *.jpg|*.jpeg|*.JPG|*.JPEG) ok=$(sips -s format jpeg -s formatOptions 72 -Z 240 "$f" --out "$t" >/dev/null && echo 1) ;;
    *)                         ok=$(sips -Z 240 "$f" --out "$t" >/dev/null && echo 1) ;;
  esac
  if [ "$ok" = 1 ]; then echo "made $t"; made=$((made+1)); else echo "failed $f" >&2; fi
done
echo "$made thumbnail(s) created"
