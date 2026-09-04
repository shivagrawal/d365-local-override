#!/bin/sh
# Regenerates the extension icon set from the SVG sources.
# Requires rsvg-convert (Debian/Ubuntu: apt install librsvg2-bin).
#
# Three sources by design: fine detail that reads well at 128px turns to
# unreadable mush at toolbar size, so smaller sizes get progressively
# coarser variants rather than a naive downscale.
set -e
cd "$(dirname "$0")/.."
rsvg-convert -w 128 -h 128 scripts/icon.svg       -o extension/icons/icon128.png
rsvg-convert -w 48  -h 48  scripts/icon.svg       -o extension/icons/icon48.png
rsvg-convert -w 32  -h 32  scripts/icon-small.svg -o extension/icons/icon32.png
rsvg-convert -w 16  -h 16  scripts/icon-tiny.svg  -o extension/icons/icon16.png
echo "Regenerated extension/icons/*.png"
