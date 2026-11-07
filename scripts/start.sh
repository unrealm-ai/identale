#!/usr/bin/env bash
# Modified for Identale; see the root NOTICE.
set -euo pipefail

start_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
start_usage() {
  cat <<'USAGE'
Usage: bash scripts/start.sh [--mock] [--no-install] [--no-build]
       sudo bash scripts/start.sh --host IP_OR_DOMAIN [server options]

No arguments: prepare Node/dependencies and persistent credentials, build, and
start macOS/Linux services on http://127.0.0.1:15173. Ctrl+C stops this instance.
Local startup creates and reads .env; process environment overrides .env settings.
New local data and credentials default to ~/.identale; existing paths are preserved.
--no-install reuses installed Node/npm and dependencies; it never downloads them.
Local startup and host deployment cannot share a running/building checkout.
--host: deploy on Debian/Ubuntu with systemd and HTTPS through Nginx.
Services and tasks run as the dedicated identity account; installation uses root.
The checkout and Node must be readable/executable by identity (avoid /root).
  --mock            Start the optional local rule model and Mock MCP (both modes)
  --port PORT       HTTPS port (default 15173; existing configuration is reused)
  --cert PATH       Existing certificate/full chain; requires --key PATH
  --key PATH        Matching private key; omitted pair uses/reuses a self-signed certificate
  --data-dir PATH   Initial server data directory; existing data is never reset
  --init-secrets    Legacy server flag; never replaces credentials for existing data
  --skip-install    Require installed dependencies and tools
  --skip-build      Reuse build outputs
Server options are never inferred from the OS. Without arguments startup is local.
USAGE
}

start_server() {
  setup_skip_install=false
  setup_host=''
  setup_port=''
  setup_cert=''
  setup_key=''
  setup_args=("$@")
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help) start_usage; exit 0 ;;
      --host|--port|--data-dir|--cert|--key)
        if [[ $# -lt 2 || -z $2 || $2 == --* ]]; then start_usage >&2; exit 2; fi
        case "$1" in
          --host) setup_host=$2 ;;
          --port) setup_port=$2 ;;
          --cert) setup_cert=$2 ;;
          --key) setup_key=$2 ;;
        esac
        shift 2 ;;
      --skip-install) setup_skip_install=true; shift ;;
      --skip-build|--init-secrets|--mock) shift ;;
      *) start_usage >&2; exit 2 ;;
    esac
  done
  if [[ -n $setup_host && ( $setup_host == *[!a-zA-Z0-9.-]* || $setup_host == -* || $setup_host == .* ) ]]; then
    printf 'Invalid host: use an IPv4 address or DNS name without a scheme or port.\n' >&2; exit 2
  fi
  if [[ -n $setup_port && ( ! $setup_port =~ ^[0-9]{1,5}$ || $setup_port == 0* ) ]]; then
    printf 'Invalid HTTPS port.\n' >&2; exit 2
  fi
  if [[ -n $setup_port ]] && (( setup_port < 1 || setup_port > 65535 || setup_port == 80 || (setup_port >= 18300 && setup_port <= 18304) )); then
    printf 'HTTPS port is out of range or conflicts with an internal service.\n' >&2; exit 2
  fi
  if [[ -n $setup_cert && -z $setup_key || -z $setup_cert && -n $setup_key ]]; then
    printf 'Provide --cert and --key together.\n' >&2; exit 2
  fi
  if [[ $(uname -s) != Linux || ! -d /run/systemd/system ]]; then
    printf 'This installer requires Linux with systemd running.\n' >&2; exit 1
  fi
  if [[ $EUID -ne 0 ]]; then
    printf 'Run this installer with sudo.\n' >&2; exit 1
  fi
  if [[ -z $setup_host && ! -f /etc/identity/control-plane.env ]]; then
    printf 'First deployment requires --host IP_OR_DOMAIN.\n' >&2; exit 2
  fi
  if ! command -v flock >/dev/null 2>&1; then
    printf 'The util-linux flock command is required for exclusive deployment.\n' >&2; exit 1
  fi
  exec 9>/run/identity-setup.lock
  if ! flock -n 9; then
    printf 'Another Identity deployment is running; retry after it completes.\n' >&2; exit 1
  fi

  setup_missing=false
  for setup_tool in curl openssl nginx tar gzip sha256sum getent useradd groupadd setpriv; do
    if ! command -v "$setup_tool" >/dev/null 2>&1; then setup_missing=true; fi
  done
  if $setup_missing; then
    if $setup_skip_install; then printf 'Required tools are missing; omit --skip-install.\n' >&2; exit 1; fi
    if ! command -v apt-get >/dev/null 2>&1; then printf 'Automatic package installation requires Debian/Ubuntu apt-get.\n' >&2; exit 1; fi
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl openssl nginx tar gzip coreutils util-linux passwd libc-bin
  fi

  source "$start_root/scripts/shared/bootstrap-node.sh"
  identity_ensure_node server "$setup_skip_install"
  exec node "$start_root/scripts/deploy/setup-systemd.mjs" "${setup_args[@]}"
}

if [[ $# -eq 1 && ( $1 == --help || $1 == -h ) ]]; then
  start_usage
  exit 0
fi
for start_arg in "$@"; do
  case "$start_arg" in
    --mock|--no-install|--no-build) ;;
    *) start_server "$@"; exit ;;
  esac
done
# This guard precedes downloads, initialization and local recovery. Do not stop
# or rewrite an installed server just because the checkout also supports local use.
if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  for start_unit in identity-control-plane.service identity-runtime.service identity-runtime-host.service; do
    start_directory=$(systemctl show "$start_unit" -p WorkingDirectory --value 2>/dev/null || true)
    start_state=$(systemctl show "$start_unit" -p ActiveState --value 2>/dev/null || true)
    if [[ $start_directory == "$start_root" && $start_state != inactive && $start_state != failed && -n $start_state ]]; then
      printf 'A server instance from this checkout is running. Local startup refused; no service was stopped. Use --host for server deployment.\n' >&2
      exit 1
    fi
  done
fi
source "$start_root/scripts/shared/bootstrap-node.sh"
start_skip_install=false
for start_arg in "$@"; do
  if [[ $start_arg == --no-install ]]; then start_skip_install=true; fi
done
identity_ensure_node local "$start_skip_install" --no-install
exec node "$start_root/scripts/local/local-start.mjs" "$@"
