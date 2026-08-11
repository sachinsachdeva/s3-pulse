#!/usr/bin/env bash
#
# Runs a throwaway MinIO server so S3 Pulse can be exercised end to end without
# an AWS account. Requires only Docker; the MinIO image bundles the `mc` client
# used for every bucket operation here.
#
# The endpoint deliberately uses 127.0.0.1 rather than localhost. The AWS SDK
# offers no environment variable to force path-style addressing, but it does
# select path style automatically for an IP-literal endpoint. A hostname would
# instead produce virtual-host requests to `feed.localhost:9000`, which MinIO
# rejects unless MINIO_DOMAIN is set (this script sets it anyway, so that the
# localhost spelling also works).
#
# Everything this creates is local and disposable, including the credentials.

set -euo pipefail

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

CONTAINER=${S3PULSE_LOCAL_CONTAINER:-s3pulse-minio}
IMAGE=${S3PULSE_LOCAL_IMAGE:-quay.io/minio/minio:latest}
PORT=${S3PULSE_LOCAL_PORT:-9000}
BUCKET=${S3PULSE_LOCAL_BUCKET:-feed}
PREFIX=${S3PULSE_LOCAL_PREFIX:-trades/}
ACCESS_KEY=${S3PULSE_LOCAL_ACCESS_KEY:-s3pulse}
SECRET_KEY=${S3PULSE_LOCAL_SECRET_KEY:-s3pulsedev}
REGION=${S3PULSE_LOCAL_REGION:-us-east-1}
ENDPOINT="http://127.0.0.1:${PORT}"
PROFILE_NAME=${S3PULSE_LOCAL_PROFILE:-s3pulse-local}

usage() {
  cat <<USAGE
Usage: scripts/local-s3.sh <command> [options]

Commands:
  up [-n COUNT] [-s SPACING]  Start MinIO, create the bucket, seed a backlog
  seed [-n COUNT] [-s SPACING]  Add more objects with the given spacing
  feed [-s SPACING]           Add one object every SPACING seconds until Ctrl-C
  run ARGS...                 Run the built CLI against this server
  env                         Print shell exports for the CLI
  profile                     Print an AWS profile snippet for the extension
  status                      Show container and bucket state
  down                        Stop and remove the container and its data

Options:
  -n COUNT     Objects to create (default 8)
  -s SPACING   Seconds between objects (default 2)

Environment overrides: S3PULSE_LOCAL_PORT, S3PULSE_LOCAL_BUCKET,
S3PULSE_LOCAL_PREFIX, S3PULSE_LOCAL_CONTAINER, S3PULSE_LOCAL_IMAGE.
USAGE
}

fail() {
  printf 'local-s3: %s\n' "$1" >&2
  exit 1
}

require_docker() {
  command -v docker >/dev/null 2>&1 || fail 'docker is not installed'
  docker info >/dev/null 2>&1 || fail 'the Docker daemon is not running'
}

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = 'true' ]
}

require_running() {
  container_running || fail "$CONTAINER is not running; start it with: scripts/local-s3.sh up"
}

# mc talks to the server from inside the container, so the host needs no client.
mc() {
  docker exec "$CONTAINER" mc "$@"
}

wait_for_ready() {
  for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" mc alias set local "http://127.0.0.1:9000" \
      "$ACCESS_KEY" "$SECRET_KEY" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  docker logs "$CONTAINER" 2>&1 | tail -20 >&2
  fail 'MinIO did not become ready within 30s'
}

# S3 sets LastModified at upload time, so a realistic cadence has to be created
# by spacing the uploads rather than by backdating the objects.
seed_objects() {
  local count=$1 spacing=$2 index stamp
  local start
  start=$(mc ls --recursive "local/${BUCKET}/${PREFIX}" 2>/dev/null | wc -l | tr -d ' ')
  for index in $(seq 1 "$count"); do
    stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    printf 'symbol,price,quantity,captured_at\nACME,%s,%s,%s\n' \
      "$((100 + RANDOM % 400))" "$((1 + RANDOM % 900))" "$stamp" |
      docker exec -i "$CONTAINER" mc pipe \
        "local/${BUCKET}/${PREFIX}trades_$(printf '%04d' "$((start + index))").csv" >/dev/null
    printf 'arrived %strades_%04d.csv at %s\n' "$PREFIX" "$((start + index))" "$stamp"
    [ "$index" -lt "$count" ] && sleep "$spacing"
  done
  return 0
}

parse_options() {
  COUNT=8
  SPACING=2
  while getopts ':n:s:' option; do
    case $option in
      n) COUNT=$OPTARG ;;
      s) SPACING=$OPTARG ;;
      *) usage >&2; exit 1 ;;
    esac
  done
  case $COUNT in ''|*[!0-9]*) fail 'COUNT must be a whole number' ;; esac
  case $SPACING in ''|*[!0-9.]*) fail 'SPACING must be a number' ;; esac
}

command_up() {
  parse_options "$@"
  require_docker
  if container_running; then
    printf 'local-s3: %s is already running\n' "$CONTAINER"
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    # MINIO_DOMAIN lets the server also accept virtual-host-style requests, so
    # the endpoint works whether it is spelled 127.0.0.1 or localhost.
    docker run --detach --name "$CONTAINER" \
      --publish "${PORT}:9000" \
      --env "MINIO_ROOT_USER=${ACCESS_KEY}" \
      --env "MINIO_ROOT_PASSWORD=${SECRET_KEY}" \
      --env 'MINIO_DOMAIN=localhost' \
      "$IMAGE" server /data >/dev/null
    printf 'local-s3: started %s on %s\n' "$CONTAINER" "$ENDPOINT"
  fi
  wait_for_ready
  mc mb --ignore-existing "local/${BUCKET}" >/dev/null
  printf 'local-s3: seeding %s objects %ss apart\n' "$COUNT" "$SPACING"
  seed_objects "$COUNT" "$SPACING"
  printf '\nReady. s3://%s/%s\n\n' "$BUCKET" "$PREFIX"
  printf 'Point the CLI at it:\n  scripts/local-s3.sh run stats s3://%s/%s\n\n' \
    "$BUCKET" "$PREFIX"
  printf 'Keep objects arriving:\n  scripts/local-s3.sh feed -s %s\n' "$SPACING"
}

command_seed() {
  parse_options "$@"
  require_docker
  require_running
  wait_for_ready
  seed_objects "$COUNT" "$SPACING"
}

command_feed() {
  parse_options "$@"
  require_docker
  require_running
  wait_for_ready
  printf 'local-s3: an object every %ss. Press Ctrl-C to stop.\n' "$SPACING"
  while true; do
    seed_objects 1 "$SPACING"
    sleep "$SPACING"
  done
}

# Applying the environment and running the CLI in one step, so a forgotten
# `eval` cannot send the request to real AWS (or to IMDS, which manifests as an
# unhelpful "dispatch failure").
command_run() {
  local binary
  binary=${S3PULSE_BIN:-}
  if [ -z "$binary" ]; then
    for candidate in "$REPO_ROOT/target/release/s3pulse" "$REPO_ROOT/target/debug/s3pulse"; do
      [ -x "$candidate" ] && binary=$candidate && break
    done
  fi
  [ -n "$binary" ] || fail 'no s3pulse binary found; run: cargo build --release -p s3pulse-cli'
  [ -x "$binary" ] || fail "not executable: $binary"
  [ "$#" -gt 0 ] || fail 'run needs CLI arguments, for example: run stats s3://feed/trades/'
  require_docker
  require_running
  AWS_ENDPOINT_URL_S3=$ENDPOINT \
  AWS_ACCESS_KEY_ID=$ACCESS_KEY \
  AWS_SECRET_ACCESS_KEY=$SECRET_KEY \
  AWS_REGION=$REGION \
    exec "$binary" "$@"
}

command_env() {
  # AWS_ENDPOINT_URL_S3 is read by the AWS SDK; the explicit keys keep the
  # credential chain from reaching a real profile.
  cat <<ENV
export AWS_ENDPOINT_URL_S3=${ENDPOINT}
export AWS_ACCESS_KEY_ID=${ACCESS_KEY}
export AWS_SECRET_ACCESS_KEY=${SECRET_KEY}
export AWS_REGION=${REGION}
ENV
}

command_profile() {
  cat <<PROFILE
# Append to ~/.aws/config — lets the VS Code extension reach this server by
# setting the feed's AWS profile to "${PROFILE_NAME}".
[profile ${PROFILE_NAME}]
region = ${REGION}
endpoint_url = ${ENDPOINT}

# Append to ~/.aws/credentials — local throwaway keys, not real credentials.
[${PROFILE_NAME}]
aws_access_key_id = ${ACCESS_KEY}
aws_secret_access_key = ${SECRET_KEY}
PROFILE
}

command_status() {
  require_docker
  if ! container_running; then
    printf 'local-s3: %s is not running\n' "$CONTAINER"
    return 0
  fi
  printf 'local-s3: %s running on %s\n' "$CONTAINER" "$ENDPOINT"
  wait_for_ready
  printf 'local-s3: %s objects under s3://%s/%s\n' \
    "$(mc ls --recursive "local/${BUCKET}/${PREFIX}" 2>/dev/null | wc -l | tr -d ' ')" \
    "$BUCKET" "$PREFIX"
}

command_down() {
  require_docker
  docker rm -f "$CONTAINER" >/dev/null 2>&1 &&
    printf 'local-s3: removed %s\n' "$CONTAINER" ||
    printf 'local-s3: %s was not present\n' "$CONTAINER"
}

case ${1:-} in
  up) shift; command_up "$@" ;;
  seed) shift; command_seed "$@" ;;
  feed) shift; command_feed "$@" ;;
  run) shift; command_run "$@" ;;
  env) shift; command_env ;;
  profile) shift; command_profile ;;
  status) shift; command_status ;;
  down) shift; command_down ;;
  -h|--help|help) usage ;;
  '') usage >&2; exit 1 ;;
  *) printf 'local-s3: unknown command "%s"\n\n' "$1" >&2; usage >&2; exit 1 ;;
esac
