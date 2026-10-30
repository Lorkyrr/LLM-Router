#!/usr/bin/env bash
set -euo pipefail

CLUSTER="${KIND_CLUSTER:-router-ci}"

# `kind delete cluster` já sai com 0 se o cluster não existe.
kind delete cluster --name "$CLUSTER"
