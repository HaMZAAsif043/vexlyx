#!/bin/sh
set -eu

root=/var/lib/vexlyx-mail/postfix
action=${1:-health}
generation=${2:-$(sed -n '1s/^# generation://p' "$root/active.conf")}
case "$generation" in *[!0-9a-f]*|'') echo "Invalid Postfix generation" >&2; exit 1;; esac
[ "${#generation}" -eq 32 ]
directory="$root/generations/$generation"
[ -d "$directory" ] && [ ! -L "$directory" ]

case "$action" in
  prepare)
    writer_uid=$(stat -c %u "$root")
    chmod 755 "$root" "$root/generations" "$directory"
    temporary=$(mktemp -d)
    trap 'rm -rf "$temporary"' EXIT HUP INT TERM
    for name in virtual_mailbox_maps virtual_alias_maps; do
      [ -f "$directory/$name" ] && [ ! -L "$directory/$name" ]
      sed '/^__vexlyx_generation__[[:space:]]/d' "$directory/$name" > "$temporary/$name"
      printf '__vexlyx_generation__ %s\n' "$generation" >> "$temporary/$name"
      postmap "lmdb:$temporary/$name"
      [ "$(postmap -q __vexlyx_generation__ "lmdb:$temporary/$name")" = "$generation" ]
      cat "$temporary/$name" > "$directory/$name"
      cp "$temporary/$name.lmdb" "$directory/$name.lmdb"
      chmod 644 "$directory/$name" "$directory/$name.lmdb"
    done
    chmod 644 "$directory/virtual_domains"
    (cd "$directory"; sha256sum virtual_domains virtual_mailbox_maps virtual_alias_maps virtual_mailbox_maps.lmdb virtual_alias_maps.lmdb > .sha256)
    chown "$writer_uid" "$directory" "$directory/virtual_domains" "$directory/virtual_mailbox_maps" "$directory/virtual_alias_maps" "$directory/virtual_mailbox_maps.lmdb" "$directory/virtual_alias_maps.lmdb" "$directory/.sha256"
    chmod 644 "$directory/.sha256"
    ;;
  configure|activate)
    while IFS= read -r setting; do
      case "$setting" in '#'*|'') continue;; esac
      postconf -e "$setting"
    done < "$root/active.conf"
    if [ "$action" = activate ]; then postfix reload; fi
    ;;
  health)
    postfix status >/dev/null
    [ "$(postconf -h virtual_mailbox_domains)" = "$directory/virtual_domains" ]
    [ "$(postconf -h virtual_mailbox_maps)" = "lmdb:$directory/virtual_mailbox_maps" ]
    [ "$(postconf -h virtual_alias_maps)" = "lmdb:$directory/virtual_alias_maps" ]
    su -s /bin/sh postfix -c "cd '$directory' && sha256sum -c .sha256 >/dev/null"
    for name in virtual_mailbox_maps virtual_alias_maps; do
      result=$(su -s /bin/sh postfix -c "postmap -q __vexlyx_generation__ 'lmdb:$directory/$name'")
      [ "$result" = "$generation" ]
    done
    ;;
  *) echo "Unknown Postfix mail-state action" >&2; exit 1;;
esac
