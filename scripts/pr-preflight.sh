#!/usr/bin/env bash
set -euo pipefail

repo_path="${1:-}"

emit_fail() {
  local msg="$1"
  echo "PRECHECK_STATUS: fail"
  echo "PR_READY: no"
  echo "PRECHECK_ERROR: ${msg}"
  exit 2
}

if [[ -z "${repo_path}" ]]; then
  emit_fail "Missing repository path argument"
fi

if [[ ! -d "${repo_path}" ]]; then
  emit_fail "Repository path does not exist: ${repo_path}"
fi

if ! git -C "${repo_path}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  emit_fail "Not a git repository: ${repo_path}"
fi

remote_count="$(git -C "${repo_path}" remote | wc -l | tr -d ' ')"
if [[ "${remote_count}" == "0" ]]; then
  emit_fail "No git remote configured. Add a remote before running PR workflows."
fi

if ! command -v gh >/dev/null 2>&1; then
  emit_fail "GitHub CLI (gh) is not installed in the execution environment."
fi

if ! gh auth status >/dev/null 2>&1; then
  emit_fail "GitHub CLI is not authenticated. Run: gh auth login"
fi

default_remote="$(git -C "${repo_path}" remote | head -n 1)"
echo "PRECHECK_STATUS: ok"
echo "PR_READY: yes"
echo "REPO_PATH: ${repo_path}"
echo "REMOTE_COUNT: ${remote_count}"
echo "DEFAULT_REMOTE: ${default_remote}"
echo "GH_AUTH: ok"
