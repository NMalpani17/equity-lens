#!/usr/bin/env bash
# Decides what the Deploy workflow ships for commit $SHA.
#
# Each service is compared with the commit it is running (its image tag), not
# with the previous push, so changes from skipped or failed runs are never
# missed. MODE is "changed" (detect) or a manual choice: ai-service, api, both.
# Writes ai_service, api and migrations (true/false) to $GITHUB_OUTPUT.
set -euo pipefail
: "${SHA:?}" "${REGION:?}" "${API_SERVICE:?}" "${AI_SERVICE:?}"

# Commit (image tag) the service is running.
deployed_sha() {
  local image
  image=$(gcloud run services describe "$1" --region "$REGION" \
    --format='value(spec.template.spec.containers[0].image)')
  echo "${image##*:}"
}

# changed <var> <deployed sha> <path>...: sets <var> to "true" if a path
# differs between the deployed commit and $SHA, or the deployed commit is
# unknown. An older run whose commit is behind what is deployed changes
# nothing (never roll back).
# shellcheck disable=SC2034 # result is a nameref to the caller's variable
changed() {
  local -n result=$1
  local base=$2
  shift 2
  if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
    echo "::notice::Deployed commit '${base}' not found; treating $* as changed."
    result=true
  elif ! git merge-base --is-ancestor "$base" "$SHA"; then
    echo "::notice::Deployed commit ${base} is not behind ${SHA}; skipping $*."
    result=false
  elif git diff --quiet "$base" "$SHA" -- "$@"; then
    result=false
  else
    result=true
  fi
}

ai_service="" api="" migrations=""
api_base=$(deployed_sha "$API_SERVICE")
ai_base=$(deployed_sha "$AI_SERVICE")

case "${MODE:-changed}" in
  changed)
    changed ai_service "$ai_base" ai-service
    changed api "$api_base" api
    ;;
  ai-service) ai_service=true api=false ;;
  api) ai_service=false api=true ;;
  both) ai_service=true api=true ;;
  *)
    echo "::error::Unknown services input '${MODE}'."
    exit 1
    ;;
esac
changed migrations "$api_base" api/prisma/migrations

{
  echo "ai_service=${ai_service}"
  echo "api=${api}"
  echo "migrations=${migrations}"
} >>"$GITHUB_OUTPUT"

{
  echo "### Deploy plan for \`${SHA:0:7}\`"
  echo "| Target | Running | Deploy |"
  echo "| --- | --- | --- |"
  echo "| migrations | \`${api_base:0:7}\` | ${migrations} |"
  echo "| ${AI_SERVICE} | \`${ai_base:0:7}\` | ${ai_service} |"
  echo "| ${API_SERVICE} | \`${api_base:0:7}\` | ${api} |"
} >>"$GITHUB_STEP_SUMMARY"
