#!/usr/bin/env bash
set -euo pipefail

run=false
for arg in "$@"; do
  case "$arg" in
    --run) run=true ;;
    -h|--help)
      echo "Usage: $0 [--run]"
      echo "Build the firehose Docker image; --run also starts it in the foreground."
      echo "Optional environment: IMAGE_NAME (firehose), HOST_PORT (3000)."
      exit 0
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
image_name="${IMAGE_NAME:-firehose}"

docker build --tag "$image_name" "$project_dir"

if "$run"; then
  run_args=(run --rm --init)
  if [[ -f "$project_dir/.env" ]]; then
    run_args+=(--env-file "$project_dir/.env")
  fi
  exec docker "${run_args[@]}" \
    --env PORT=3000 \
    --publish "${HOST_PORT:-3000}:3000" \
    "$image_name"
fi
