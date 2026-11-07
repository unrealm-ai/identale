#!/usr/bin/env bash
# Modified for Identale; see the root NOTICE.
# Sourced by start.sh for both modes. No installation happens while loaded.
identity_verify_node_archive() {
  local archive_file=$1 manifest=$2 archive_name=$3 checksum actual
  checksum=$(awk -v archive="$archive_name" '$2 == archive {print $1}' "$manifest") || return 1
  [[ $checksum =~ ^[a-f0-9]{64}$ ]] || { printf 'Official Node checksum is missing or ambiguous.\n' >&2; return 1; }
  if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$archive_file") || return 1
  else actual=$(shasum -a 256 "$archive_file") || return 1; fi
  [[ ${actual%% *} == "$checksum" ]] || { printf 'Node archive checksum mismatch.\n' >&2; return 1; }
}
identity_create_runtime_base() {
  # Local runtime storage shares an ancestor with private credentials.
  # Only newly created directories become private; never chmod existing paths.
  # Server runtime binaries must remain traversable by their service user.
  if [[ ${2:-local} == server ]]; then mkdir -p -- "$1"
  else (umask 077; mkdir -p -- "$1"); fi
}
identity_server_node_allowed() {
  local installed_node=${1:-}
  if [[ -z $installed_node ]]; then installed_node=$(node -p 'process.execPath') || return 1; fi
  case "$installed_node" in /root|/root/*) return 1 ;; esac
}
identity_ensure_node() {
  local purpose=${1:-local} skip_install=${2:-false} skip_flag=${3:---skip-install} system architecture archive base destination temporary checksum actual
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a===24&&b>=19?0:1)' 2>/dev/null &&
    { [[ $purpose != server ]] || identity_server_node_allowed; }; then
    return
  fi
  case "$(uname -s)" in Darwin) system=darwin ;; Linux) system=linux ;; *) printf 'Supported systems: macOS and Linux.\n' >&2; return 1 ;; esac
  case "$(uname -m)" in x86_64) architecture=x64 ;; arm64|aarch64) architecture=arm64 ;; *) printf 'Supported architectures: x64 and arm64.\n' >&2; return 1 ;; esac
  if [[ $purpose == server ]]; then base=/opt/identity
  else
    base="$HOME/.identale/node"
  fi
  archive="node-v24.19.0-${system}-${architecture}.tar.gz"
  destination="$base/${archive%.tar.gz}"
  [[ $base == /* ]] || { printf 'The managed runtime directory must be absolute.\n' >&2; return 1; }
  if [[ -L $base || -L $destination ]]; then printf 'Managed Node directories must not be symlinks.\n' >&2; return 1; fi
  if [[ ! -e $destination ]]; then
    if [[ $skip_install == true ]]; then
      printf 'Node.js >=24.19.0 and <25 with npm is required; no managed runtime exists and %s forbids downloading it.\n' "$skip_flag" >&2; return 1
    fi
    for actual in curl tar gzip awk mktemp mv; do
      if ! command -v "$actual" >/dev/null 2>&1; then printf 'Install the required base tool first: %s\n' "$actual" >&2; return 1; fi
    done
    if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
      printf 'A SHA-256 tool (sha256sum or shasum) is required before downloading Node.\n' >&2; return 1
    fi
    identity_create_runtime_base "$base" "$purpose" || return 1
    # Serialize the download/publication. A competing invocation can be retried.
    if ! mkdir "$base/.node-install.lock" 2>/dev/null; then printf 'Another Node installation is running; retry after it finishes.\n' >&2; return 1; fi
    temporary=$(mktemp -d "$base/.node-download.XXXXXX") || { rmdir "$base/.node-install.lock"; return 1; }
    # A subshell owns cleanup even on download, checksum, extraction or signal failure.
    if ! (
      trap 'rm -rf -- "$temporary"; rmdir "$base/.node-install.lock"' EXIT
      trap 'exit 130' INT
      trap 'exit 143' TERM
      curl --proto '=https' --tlsv1.2 -fSs --connect-timeout 15 --max-time 300 "https://nodejs.org/dist/v24.19.0/$archive" -o "$temporary/$archive" || exit 1
      curl --proto '=https' --tlsv1.2 -fSs --connect-timeout 15 --max-time 60 https://nodejs.org/dist/v24.19.0/SHASUMS256.txt -o "$temporary/SHASUMS256.txt" || exit 1
      identity_verify_node_archive "$temporary/$archive" "$temporary/SHASUMS256.txt" "$archive" || exit 1
      tar -xzf "$temporary/$archive" -C "$temporary" || exit 1
      "$temporary/${archive%.tar.gz}/bin/node" -e 'process.exit(process.versions.node==="24.19.0"?0:1)' || exit 1
      mv -- "$temporary/${archive%.tar.gz}" "$destination" || exit 1
    ); then return 1; fi
  fi
  [[ -x $destination/bin/node && -f $destination/bin/npm ]] || { printf 'Managed Node installation is incomplete: %s\n' "$destination" >&2; return 1; }
  "$destination/bin/node" -e 'process.exit(process.versions.node==="24.19.0"?0:1)' || return 1
  export PATH="$destination/bin:$PATH"
  npm --version >/dev/null
}
