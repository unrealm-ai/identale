#!/usr/bin/env bash
# A startup gate, not a resident guardian: exec preserves this PID and process
# group. The manager persists ownership before allowing the command to execute.
set -euo pipefail
IFS= read -r local_start_permission <&3 || exit 1
[[ $local_start_permission == run ]] || exit 1
exec 3<&-
exec "$@"
