#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-manz}"
NAMESPACE="${NAMESPACE:-}"
CLUSTER_CONTAINER="${CLUSTER_CONTAINER:-openshell-cluster-nemoclaw}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="${ROOT_DIR}/nemoclaw"
ARCHIVE="/tmp/nemoclaw-dist.tgz"

echo "Building NemoClaw plugin..."
cd "${PLUGIN_DIR}"
npm run build

echo "Creating archive ${ARCHIVE}..."
tar -czf "${ARCHIVE}" dist openclaw.plugin.json package.json

detect_namespace() {
  if [[ -n "${NAMESPACE}" ]]; then
    # Validate the provided namespace exists; otherwise ignore and auto-detect.
    if command -v docker >/dev/null 2>&1; then
      if docker exec -i "${CLUSTER_CONTAINER}" sh -lc "kubectl get ns '${NAMESPACE}' >/dev/null 2>&1"; then
        echo "${NAMESPACE}"
        return 0
      fi
    elif command -v kubectl >/dev/null 2>&1; then
      if kubectl get ns "${NAMESPACE}" >/dev/null 2>&1; then
        echo "${NAMESPACE}"
        return 0
      fi
    fi
    echo "WARN: provided NAMESPACE='${NAMESPACE}' does not exist; auto-detecting..." >&2
    NAMESPACE=""
  fi

  # If we're using the cluster container workflow, detect namespace there (host kubectl
  # may not be configured or may point at a different cluster).
  if command -v docker >/dev/null 2>&1; then
    local ns
    ns="$(docker exec -i "${CLUSTER_CONTAINER}" sh -lc "
      kubectl get pods -A --no-headers 2>/dev/null \
        | awk '\$2 == \"${SANDBOX_NAME}\" {print \$1; exit}'
    " | tr -d '\r' | tail -n 1)"
    if [[ -z "${ns}" ]]; then
      ns="$(docker exec -i "${CLUSTER_CONTAINER}" sh -lc "
        kubectl get pods -A --no-headers 2>/dev/null \
          | awk '\$2 ~ /(^|-)${SANDBOX_NAME}(\$|-)$/ {print \$1; exit}'
      " | tr -d '\r' | tail -n 1)"
    fi
    if [[ -n "${ns}" ]]; then
      echo "${ns}"
      return 0
    fi
  fi

  # Fallback: try host kubectl if present.
  if command -v kubectl >/dev/null 2>&1; then
    local ns
    ns="$(kubectl get pods -A --no-headers 2>/dev/null \
      | awk -v name="${SANDBOX_NAME}" '$2 ~ ("(^|-)" name "($|-)$") {print $1; exit}' \
      | tr -d '\r' | tail -n 1)"
    if [[ -n "${ns}" ]]; then
      echo "${ns}"
      return 0
    fi
  fi

  echo "ERROR: could not auto-detect namespace for sandbox '${SANDBOX_NAME}'." >&2
  echo "Hint: set NAMESPACE=... and SANDBOX_NAME=... explicitly." >&2
  echo "If using the cluster container workflow, try:" >&2
  echo "  docker exec -it ${CLUSTER_CONTAINER} sh -lc 'kubectl get pods -A | head -n 50'" >&2
  exit 3
}

NAMESPACE="$(detect_namespace)"
echo "Using namespace: ${NAMESPACE}"

if command -v docker >/dev/null 2>&1; then
  echo "Copying archive into cluster container (${CLUSTER_CONTAINER})..."
  docker cp "${ARCHIVE}" "${CLUSTER_CONTAINER}:/tmp/nemoclaw-dist.tgz"

  echo "Copying archive into sandbox pod (${SANDBOX_NAME})..."
  docker exec -it "${CLUSTER_CONTAINER}" sh -lc \
    "kubectl -n ${NAMESPACE} cp /tmp/nemoclaw-dist.tgz ${SANDBOX_NAME}:/tmp/nemoclaw-dist.tgz"
elif command -v kubectl >/dev/null 2>&1; then
  echo "Copying archive into sandbox pod (${SANDBOX_NAME}) via kubectl..."
  kubectl -n "${NAMESPACE}" cp "${ARCHIVE}" "${SANDBOX_NAME}:/tmp/nemoclaw-dist.tgz"
else
  echo "ERROR: need docker or kubectl to copy into the sandbox." >&2
  exit 2
fi

echo "Swapping plugin dist inside the sandbox..."
if command -v docker >/dev/null 2>&1; then
  # Remote shell script: variables expand inside the pod, not on the host.
  # shellcheck disable=SC2016
  docker exec -it "${CLUSTER_CONTAINER}" sh -lc \
    "kubectl -n ${NAMESPACE} exec ${SANDBOX_NAME} -- sh -lc '
set -e
BASE=\"/sandbox/.openclaw-data/extensions/nemoclaw\"
mkdir -p \"\$BASE/dist.new\"
# Avoid preserving host numeric owners (e.g. uid=501) into the pod.
tar -xzf /tmp/nemoclaw-dist.tgz -C \"\$BASE/dist.new\" --no-same-owner --no-same-permissions
if [ -d \"\$BASE/dist.bak\" ]; then
  mv \"\$BASE/dist.bak\" \"\$BASE/dist.bak.prev.\$(date +%s)\" || true
fi
mv \"\$BASE/dist\" \"\$BASE/dist.bak\"
mv \"\$BASE/dist.new/dist\" \"\$BASE/dist\"
chown -R 998:998 \"\$BASE/dist\" 2>/dev/null || true
echo \"Verifying deployed policy handler exists...\"
grep -n \"case \\\"policy\\\"\" \"\$BASE/dist/commands/slash.js\" >/dev/null
echo \"OK: policy handler present in \$BASE/dist/commands/slash.js\"
echo \"OK: updated \$BASE/dist\"
'"
else
  # shellcheck disable=SC2016
  kubectl -n "${NAMESPACE}" exec "${SANDBOX_NAME}" -- sh -lc '
set -e
BASE="/sandbox/.openclaw-data/extensions/nemoclaw"
mkdir -p "$BASE/dist.new"
tar -xzf /tmp/nemoclaw-dist.tgz -C "$BASE/dist.new" --no-same-owner --no-same-permissions
if [ -d "$BASE/dist.bak" ]; then
  mv "$BASE/dist.bak" "$BASE/dist.bak.prev.$(date +%s)" || true
fi
mv "$BASE/dist" "$BASE/dist.bak"
mv "$BASE/dist.new/dist" "$BASE/dist"
chown -R 998:998 "$BASE/dist" 2>/dev/null || true
echo "Verifying deployed policy handler exists..."
grep -n "case \"policy\"" "$BASE/dist/commands/slash.js" >/dev/null
echo "OK: policy handler present in $BASE/dist/commands/slash.js"
echo "OK: updated $BASE/dist"
'
fi

echo ""
echo "Done. Fully restart OpenClaw TUI to pick up changes."
echo ""
echo "Suggested restart command (run inside the sandbox shell):"
echo "  OPENCLAW_STATE_DIR=\"/sandbox/.openclaw-data\" \\"
echo "    OPENCLAW_CONFIG_PATH=\"/sandbox/.openclaw-data/openclaw.json\" \\"
echo "    openclaw tui"
echo ""
echo "If /nemoclaw still hits port 8000, OpenClaw is not passing STEWARD_URL to the plugin."
echo "Set stewardUrl in openclaw.json for nemoclaw, e.g.:"
echo "  \"stewardUrl\": \"http://host.openshell.internal:8010\""
echo "(STEWARD_URL on the host is optional if stewardUrl is set.)"
