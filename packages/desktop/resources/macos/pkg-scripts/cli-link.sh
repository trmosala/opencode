#!/bin/sh

register_cookiemonster_cli() (
  cli=$1
  destination=$2
  directory=${destination%/*}
  legacy=${cli%/cli/opencode}/opencode-cli

  if [ ! -f "$cli" ] || [ ! -x "$cli" ]; then
    echo "The bundled CookieMonster CLI is missing or is not executable." >&2
    return 1
  fi
  if ! "$cli" --version >/dev/null 2>&1; then
    echo "The bundled CookieMonster CLI failed validation." >&2
    return 1
  fi
  if [ -e "$directory" ] && [ ! -d "$directory" ]; then
    echo "$directory exists and is not a directory." >&2
    return 1
  fi
  if [ ! -e "$directory" ]; then
    (umask 022; /bin/mkdir -p -m 0755 "$directory") || return 1
  fi

  if [ -e "$destination" ] || [ -L "$destination" ]; then
    if [ ! -L "$destination" ]; then
      echo "$destination belongs to another installation." >&2
      return 1
    fi
    target=$(/usr/bin/readlink "$destination")
    if [ "$target" != "$cli" ] && [ "$target" != "$legacy" ]; then
      echo "$destination belongs to another installation." >&2
      return 1
    fi
  fi

  temporary="$directory/.opencode.cookiemonster.$$"
  trap '/bin/rm -f "$temporary"' EXIT HUP INT TERM
  /bin/ln -s "$cli" "$temporary"
  /bin/mv -f "$temporary" "$destination"
  trap - EXIT HUP INT TERM
)
