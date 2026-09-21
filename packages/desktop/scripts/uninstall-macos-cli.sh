#!/bin/sh
set -eu

destination=/usr/local/bin/opencode
current=/Applications/CookieMonster.app/Contents/Resources/cli/opencode
legacy=/Applications/CookieMonster.app/Contents/Resources/opencode-cli

if [ ! -e "$destination" ] && [ ! -L "$destination" ]; then
  exit 0
fi
if [ ! -L "$destination" ]; then
  echo "$destination is not owned by CookieMonster; it was not removed." >&2
  exit 1
fi
target=$(/usr/bin/readlink "$destination")
if [ "$target" != "$current" ] && [ "$target" != "$legacy" ]; then
  echo "$destination is not owned by CookieMonster; it was not removed." >&2
  exit 1
fi
/bin/rm "$destination"
