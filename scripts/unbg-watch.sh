#!/usr/bin/env bash
# unbg supervisor — keeps `astro dev` alive and pulls new commits from GitHub.
#
# Started by `unbg` in the background (nohup). Loop:
#   1. run the dev server as a child process
#   2. every UNBG_CHECK_INTERVAL seconds (default 180) ask GitHub for new commits
#   3. new commit? fast-forward the repo. Astro's dev server hot-reloads the
#      changed files by itself; if package.json / the lockfile / astro.config
#      changed, the child is restarted instead.
#   4. child died? start it again (2 s backoff)
#   5. child alive but not answering on the port (astro sometimes wedges)? kill it
#      and start again — a browser "localhost refused to connect" fixes itself.
#
# Everything is local — nothing is deployed.

set -uo pipefail

APP_DIR="${UNBG_DIR:-$HOME/unbg}"
PORT="${UNBG_PORT:-4321}"
INTERVAL_FILE="$HOME/.unbg-interval"
if [ -n "${UNBG_CHECK_INTERVAL:-}" ]; then
  CHECK_INTERVAL="$UNBG_CHECK_INTERVAL"
elif [ -s "$INTERVAL_FILE" ]; then
  CHECK_INTERVAL="$(tr -dc '0-9' <"$INTERVAL_FILE")"
else
  CHECK_INTERVAL=1
fi
[ "${CHECK_INTERVAL:-0}" -ge 1 ] 2>/dev/null || CHECK_INTERVAL=1
TOKEN_FILE="$HOME/.unbg-token"
LOG_FILE="${UNBG_LOG:-$HOME/.unbg-server.log}"
BRANCH="main"

say() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }

log() { say "$*" >>"$LOG_FILE"; }

token() {
  if [ -n "${UNBG_TOKEN:-}" ]; then printf '%s' "$UNBG_TOKEN"; return; fi
  [ -s "$TOKEN_FILE" ] && tr -d '\n' <"$TOKEN_FILE"
}

CHILD=0
HEALTH_FAILS=0
HEALTH_EVERY="${UNBG_HEALTH_INTERVAL:-15}"   # seconds between "is it actually serving?" probes
HEALTH_LIMIT="${UNBG_HEALTH_LIMIT:-4}"       # consecutive misses before recycling (~60 s)

stop_child() {
  if [ "$CHILD" != "0" ] && kill -0 "$CHILD" 2>/dev/null; then
    # astro spawns its own tree; kill the group politely, then firmly
    pkill -P "$CHILD" 2>/dev/null || true
    kill "$CHILD" 2>/dev/null || true
    sleep 1
    kill -9 "$CHILD" 2>/dev/null || true
  fi
  CHILD=0
}

on_exit() {
  log "supervisor exiting — stopping dev server"
  stop_child
  exit 0
}
trap on_exit INT TERM

start_child() {
  cd "$APP_DIR" || return 1
  npm run dev -- --host 0.0.0.0 --port "$PORT" --force >>"$LOG_FILE" 2>&1 &
  CHILD=$!
  HEALTH_FAILS=0
  log "dev server started (pid $CHILD, port $PORT)"
}

# Is *our* app answering? /version.json is cheap and only unbg has it.
serving() {
  local body
  body="$(curl -fsS --max-time 4 "http://127.0.0.1:${PORT}/version.json" 2>/dev/null)" || return 1
  case "$body" in
    *'"app":"unbg"'*|*'"app": "unbg"'*) return 0 ;;
    *) return 1 ;;
  esac
}

# Something else may hold the port (a stray astro, another project). Say so once.
port_holder_hint() {
  command -v ss >/dev/null 2>&1 || return 0
  local holder
  holder="$(ss -tlnp 2>/dev/null | awk -v p=":${PORT}\$" '$4 ~ p {print $6}' | head -1)"
  [ -n "$holder" ] && log "port $PORT is held by: $holder"
}

# One tiny request: what commit does origin/main point at right now?
remote_sha() {
  local tok; tok="$(token)"
  [ -n "$tok" ] || return 1
  timeout 20 git ls-remote --heads "https://x-access-token:${tok}@github.com/vishubizzonl-ship-it/unbg.git" "$BRANCH" 2>/dev/null \
    | awk '{print $1}'
}

# Fast-forward to origin/main. Returns 0 when the working tree moved.
pull_update() {
  local tok; tok="$(token)"
  [ -n "$tok" ] || { log "no token — update check skipped"; return 1; }

  local url="https://x-access-token:${tok}@github.com/vishubizzonl-ship-it/unbg.git"
  local before after
  before="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null)" || return 1

  # Skip the fetch entirely when the remote SHA matches what we already have.
  local probe
  probe="$(remote_sha)"
  [ -n "$probe" ] && [ "$probe" != "$before" ] || return 1

  git -C "$APP_DIR" fetch --quiet "$url" "$BRANCH" 2>/dev/null || {
    log "fetch failed (network/token) — retrying next tick"
    return 1
  }

  after="$(git -C "$APP_DIR" rev-parse FETCH_HEAD 2>/dev/null)"
  [ -n "$after" ] && [ "$before" != "$after" ] || return 1

  # Which files changed decides whether a restart is needed.
  local changed
  changed="$(git -C "$APP_DIR" diff --name-only "$before" "$after" 2>/dev/null || true)"

  if ! git -C "$APP_DIR" merge --ff-only --quiet FETCH_HEAD 2>/dev/null; then
    log "cannot fast-forward (local edits?) — update skipped"
    return 1
  fi
  log "pulled ${after:0:7} — $changed"

  if printf '%s\n' "$changed" | grep -qE '^(package\.json|package-lock\.json|astro\.config\.mjs)$'; then
    log "build config changed — reinstalling deps and restarting"
    ( cd "$APP_DIR" && npm install --ignore-scripts --no-audit --no-fund >>"$LOG_FILE" 2>&1 )
    return 0
  fi

  log "hot reload handles the rest (no restart needed)"
  return 2
}

log "supervisor up — app=$APP_DIR port=$PORT check=${CHECK_INTERVAL}s"
if [ "$CHECK_INTERVAL" -le 2 ]; then
  log "WARNING: ${CHECK_INTERVAL}s polling = ~$((86400 / CHECK_INTERVAL)) GitHub requests/day; expect battery + data use"
fi
start_child
last_check=$(date +%s)
last_health=$(date +%s)

while true; do
  sleep 1

  if [ "$CHILD" != "0" ] && ! kill -0 "$CHILD" 2>/dev/null; then
    log "dev server exited — restarting"
    CHILD=0
    sleep 2
    start_child
    continue
  fi

  now=$(date +%s)
  if [ $((now - last_health)) -ge "$HEALTH_EVERY" ]; then
    last_health=$now
    if [ "$CHILD" != "0" ] && kill -0 "$CHILD" 2>/dev/null; then
      if serving; then
        [ "$HEALTH_FAILS" -gt 0 ] && log "dev server answering again"
        HEALTH_FAILS=0
      else
        HEALTH_FAILS=$((HEALTH_FAILS + 1))
        log "health check failed ($HEALTH_FAILS/$HEALTH_LIMIT) — port $PORT not answering"
        if [ "$HEALTH_FAILS" -ge "$HEALTH_LIMIT" ]; then
          port_holder_hint
          log "recycling the dev server"
          stop_child
          sleep 2
          start_child
        fi
      fi
    fi
  fi

  if [ $((now - last_check)) -ge "$CHECK_INTERVAL" ]; then
    last_check=$now
    pull_update
    status=$?
    if [ "$status" = "0" ]; then
      log "restarting after config change"
      stop_child
      start_child
    fi
  fi
done
