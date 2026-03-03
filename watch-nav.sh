#!/usr/bin/env bash
# Thin wrapper: delegates to the Node.js Playwright-based watcher.
# Preserves same CLI surface for backward compatibility.
exec node "$(dirname "$0")/watch-nav.js" "$@"
