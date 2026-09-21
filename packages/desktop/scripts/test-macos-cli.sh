#!/bin/sh
set -eu

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT HUP INT TERM
. "$(dirname "$0")/../resources/macos/pkg-scripts/cli-link.sh"

make_cli() {
  app=$1
  mkdir -p "$app/Contents/Resources/cli"
  printf '#!/bin/sh\nexit 0\n' > "$app/Contents/Resources/cli/opencode"
  chmod 0755 "$app/Contents/Resources/cli/opencode"
}

case_root="$root/missing-destination"
make_cli "$case_root/CookieMonster.app"
register_cookiemonster_cli "$case_root/CookieMonster.app/Contents/Resources/cli/opencode" "$case_root/bin/opencode"
test "$(readlink "$case_root/bin/opencode")" = "$case_root/CookieMonster.app/Contents/Resources/cli/opencode"

register_cookiemonster_cli "$case_root/CookieMonster.app/Contents/Resources/cli/opencode" "$case_root/bin/opencode"
test "$(readlink "$case_root/bin/opencode")" = "$case_root/CookieMonster.app/Contents/Resources/cli/opencode"

case_root="$root/missing-parents"
make_cli "$case_root/CookieMonster.app"
(umask 077; register_cookiemonster_cli "$case_root/CookieMonster.app/Contents/Resources/cli/opencode" "$case_root/usr/local/bin/opencode")
test -d "$case_root/usr/local/bin"
test "$(readlink "$case_root/usr/local/bin/opencode")" = "$case_root/CookieMonster.app/Contents/Resources/cli/opencode"
for directory in "$case_root/usr" "$case_root/usr/local" "$case_root/usr/local/bin"; do
  test "$(LC_ALL=C ls -ld "$directory" | cut -c1-10)" = "drwxr-xr-x"
done
chmod 0700 "$case_root/usr/local/bin"
register_cookiemonster_cli "$case_root/CookieMonster.app/Contents/Resources/cli/opencode" "$case_root/usr/local/bin/opencode"
test "$(LC_ALL=C ls -ld "$case_root/usr/local/bin" | cut -c1-10)" = "drwx------"

case_root="$root/legacy-link"
make_cli "$case_root/CookieMonster.app"
mkdir -p "$case_root/bin"
ln -s "$case_root/CookieMonster.app/Contents/Resources/opencode-cli" "$case_root/bin/opencode"
register_cookiemonster_cli "$case_root/CookieMonster.app/Contents/Resources/cli/opencode" "$case_root/bin/opencode"
test "$(readlink "$case_root/bin/opencode")" = "$case_root/CookieMonster.app/Contents/Resources/cli/opencode"

case_root="$root/unrelated-link"
make_cli "$case_root/CookieMonster.app"
mkdir -p "$case_root/bin"
ln -s "$case_root/other-opencode" "$case_root/bin/opencode"
if register_cookiemonster_cli "$case_root/CookieMonster.app/Contents/Resources/cli/opencode" "$case_root/bin/opencode"; then exit 1; fi
test "$(readlink "$case_root/bin/opencode")" = "$case_root/other-opencode"

case_root="$root/regular-file"
make_cli "$case_root/CookieMonster.app"
mkdir -p "$case_root/bin"
printf 'owned elsewhere' > "$case_root/bin/opencode"
if register_cookiemonster_cli "$case_root/CookieMonster.app/Contents/Resources/cli/opencode" "$case_root/bin/opencode"; then exit 1; fi
grep -q 'owned elsewhere' "$case_root/bin/opencode"

case_root="$root/missing-cli"
if register_cookiemonster_cli "$case_root/CookieMonster.app/Contents/Resources/cli/opencode" "$case_root/bin/opencode"; then exit 1; fi

case_root="$root/non-executable"
make_cli "$case_root/CookieMonster.app"
chmod 0644 "$case_root/CookieMonster.app/Contents/Resources/cli/opencode"
if register_cookiemonster_cli "$case_root/CookieMonster.app/Contents/Resources/cli/opencode" "$case_root/bin/opencode"; then exit 1; fi
