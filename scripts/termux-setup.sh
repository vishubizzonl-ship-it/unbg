#!/usr/bin/env bash
# unbg — one-command Termux bootstrap + server runner.
#
# Install once:
#   curl -fsSL "https://x-access-token:<TOKEN>@raw.githubusercontent.com/vishubizzonl-ship-it/unbg/main/scripts/termux-setup.sh" \
#     -o "$PREFIX/bin/unbg" && chmod +x "$PREFIX/bin/unbg" && unbg
#
# After that, just type:  unbg
#   unbg          setup + start (auto-updates from GitHub, no manual git pull)
#   unbg status   is it running?
#   unbg logs     live log
#   unbg stop     stop the server
#   unbg restart  restart
#
# Design notes:
#  * The server runs detached (nohup + a restart loop), so closing the adb
#    keyboard or a stray Ctrl-C doesn't kill it.
#  * Every start does a fast-forward pull and only reinstalls node_modules when
#    package.json actually changed — so repeated runs are cheap.
#  * `--ignore-scripts` is mandatory on Android: onnxruntime-node's native
#    download has no Android build and would fail the install.

set -uo pipefail

REPO_OWNER="vishubizzonl-ship-it"
REPO_NAME="unbg"
APP_DIR="${UNBG_DIR:-$HOME/unbg}"
PORT="${UNBG_PORT:-4321}"
TOKEN_FILE="$HOME/.unbg-token"
PID_FILE="$HOME/.unbg-server.pid"
LOG_FILE="$HOME/.unbg-server.log"
HASH_FILE="$HOME/.unbg-deps-hash"

say() { printf '\033[1m›\033[0m %s\n' "$*"; }
ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

need_pkgs() {
  local missing=0
  command -v git >/dev/null || missing=1
  command -v node >/dev/null || missing=1
  command -v curl >/dev/null || missing=1
  if [ "$missing" = "0" ]; then return 0; fi

  if command -v pkg >/dev/null; then
    say "Installing nodejs-lts, git, curl…"
    pkg install -y nodejs-lts git curl || die "pkg install failed"
  else
    die "git/node/curl missing and no pkg manager found"
  fi
}

token() {
  if [ -n "${UNBG_TOKEN:-}" ]; then printf '%s' "$UNBG_TOKEN"; return; fi
  if [ -s "$TOKEN_FILE" ]; then tr -d '\n' <"$TOKEN_FILE"; return; fi
  printf '' # caller handles the empty case
}

save_token() {
  printf '%s' "$1" >"$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
}

# Fetch main and fast-forward. Never stores the token in .git/config.
sync_repo() {
  # A token passed through the environment is remembered once, so later runs
  # (and the auto-update) need no input at all.
  if [ -n "${UNBG_TOKEN:-}" ] && [ ! -s "$TOKEN_FILE" ]; then save_token "$UNBG_TOKEN"; fi
  local tok; tok="$(token)"

  if [ -d "$APP_DIR/.git" ]; then
    if [ -n "$tok" ]; then
      local url="https://x-access-token:${tok}@github.com/${REPO_OWNER}/${REPO_NAME}.git"
      if git -C "$APP_DIR" fetch --quiet "$url" main 2>/dev/null; then
        git -C "$APP_DIR" merge --ff-only --quiet FETCH_HEAD 2>/dev/null \
          && ok "Code updated to $(git -C "$APP_DIR" rev-parse --short HEAD)" \
          || warn "Local changes present — kept as-is"
      else
        warn "Fetch failed (token/network) — using the local copy"
      fi
    else
      warn "No token saved — using the local copy without updating"
    fi
    return 0
  fi

  say "Cloning $REPO_OWNER/$REPO_NAME…"
  mkdir -p "$(dirname "$APP_DIR")"

  if [ -z "$tok" ]; then
    printf 'GitHub token (input hidden, saved once to ~/.unbg-token): '
    local typed; read -rs typed; printf '\n'
    [ -n "$typed" ] || die "A token is required — the repo is private"
    save_token "$typed"
    tok="$typed"
  fi

  # Remember a token that arrived through the environment, so the next run
  # (and every auto-update) needs no input.
  if [ -s "$TOKEN_FILE" ] || [ -n "${UNBG_TOKEN:-}" ]; then
    [ -s "$TOKEN_FILE" ] || save_token "$tok"
  fi

  git clone --quiet "https://x-access-token:${tok}@github.com/${REPO_OWNER}/${REPO_NAME}.git" "$APP_DIR" \
    || die "Clone failed — token galat ya expire ho gaya"
  ok "Cloned into $APP_DIR"
}

install_deps() {
  local stamp
  stamp="$(node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha1").update(f.readFileSync("package.json")).digest("hex"))' 2>/dev/null || echo manual)"
  if [ -d "$APP_DIR/node_modules" ] && [ -f "$HASH_FILE" ] && [ "$(cat "$HASH_FILE" 2>/dev/null)" = "$stamp" ]; then
    ok "Dependencies already in sync"
    return 0
  fi
  say "Installing dependencies (first run: 1–3 minutes)…"
  ( cd "$APP_DIR" && npm install --ignore-scripts --no-audit --no-fund ) || die "npm install failed"
  printf '%s' "$stamp" >"$HASH_FILE"
  ok "Dependencies ready"
}

lan_ip() {
  ip -4 addr show 2>/dev/null | awk '/inet .* (wlan|eth|rmnet)/{print $2}' | cut -d/ -f1 | head -1
}

server_pid() { awk '{print $1}' "$PID_FILE" 2>/dev/null; }
server_port() { awk '{print $2}' "$PID_FILE" 2>/dev/null; }

pid_alive() {
  local pid; pid="$(server_pid)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

healthy() { curl -fsS -o /dev/null "http://127.0.0.1:$1/" 2>/dev/null; }

running() { pid_alive && [ "$(server_port)" = "$PORT" ] && healthy "$PORT"; }

start_server() {
  if running; then
    ok "Server already running (pid $(server_pid)) on port $PORT"
  else
    if pid_alive; then
      warn "Old instance on port $(server_port) — restarting on $PORT"
      kill "$(server_pid)" 2>/dev/null; pkill -f "[a]stro dev" 2>/dev/null || true; sleep 1
    fi
    say "Starting dev server on port $PORT…"
    # Detached restart loop: if the dev server ever crashes, it comes back.
    nohup bash -c "cd '$APP_DIR' && while true; do npm run dev -- --host 0.0.0.0 --port $PORT --force; sleep 2; done" \
      >"$LOG_FILE" 2>&1 &
    echo "$! $PORT" >"$PID_FILE"
    for _ in $(seq 1 40); do
      sleep 0.5
      if healthy "$PORT"; then break; fi
    done
  fi

  command -v termux-wake-lock >/dev/null && termux-wake-lock 2>/dev/null || true

  if healthy "$PORT"; then
    ok "unbg is live → http://localhost:$PORT"
    local ip; ip="$(lan_ip)"
    [ -n "$ip" ] && ok "Same Wi-Fi par: http://$ip:$PORT"
    echo "   logs: unbg logs   ·   stop: unbg stop"
    command -v termux-open >/dev/null && termux-open "http://localhost:$PORT" 2>/dev/null || true
  else
    warn "Server start hua par abhi jawab nahi de raha — 'unbg logs' dekhein"
  fi
}

case "${1:-start}" in
  start|"")
    need_pkgs
    sync_repo
    install_deps
    start_server
    # keep the installed command in sync with the repo copy
    self="$APP_DIR/scripts/termux-setup.sh"
    if [ -n "${PREFIX:-}" ] && [ -f "$self" ] && [ "$(readlink -f "$0")" != "$(readlink -f "$PREFIX/bin/unbg" 2>/dev/null)" ]; then
      cp -f "$self" "$PREFIX/bin/unbg" && chmod +x "$PREFIX/bin/unbg" && ok "Command updated: unbg"
    fi
    ;;
  status)
    if running; then
      ok "Running (pid $(server_pid)) on http://localhost:$PORT"
    else
      warn "Not running — start with: unbg"
    fi
    ;;
  logs)
    [ -f "$LOG_FILE" ] || die "No log yet — run: unbg"
    tail -n 40 -f "$LOG_FILE"
    ;;
  stop)
    if pid_alive; then
      kill "$(server_pid)" 2>/dev/null
      pkill -f "astro dev" 2>/dev/null || true
      rm -f "$PID_FILE"
      ok "Stopped"
    else
      warn "Not running"
    fi
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  update)
    sync_repo
    install_deps
    ok "Updated — restart with: unbg restart"
    ;;
  *)
    die "Unknown command: $1 (try: start | status | logs | stop | restart | update)"
    ;;
esac
