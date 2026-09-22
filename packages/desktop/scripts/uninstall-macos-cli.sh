#!/bin/sh
set -eu

. "$(/usr/bin/dirname "$0")/../resources/macos/pkg-scripts/cli-link.sh"
unregister_cookiemonster_cli "/Applications/CookieMonster.app/Contents/Resources/cli/opencode" "/usr/local/bin/opencode"
