#!/usr/bin/env bash
set -euo pipefail

CLUSTER="${KIND_CLUSTER:-router-ci}"

# Idempotente: reaproveita o cluster se um run anterior morreu antes do kind-down.
if kind get clusters | grep -qx "$CLUSTER"; then
  echo "kind cluster $CLUSTER already exists"
else
  kind create cluster --name "$CLUSTER" --wait 120s
fi
kubectl cluster-info --context "kind-$CLUSTER"
