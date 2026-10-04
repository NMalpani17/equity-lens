#!/usr/bin/env bash
# Usage: deploy-service.sh <cloud run service> <image name> <build context>
#
# Builds and pushes <image name>:$SHA, then points the existing Cloud Run
# service at it. Only the image changes: settings, env vars, secrets, probes
# and IAM stay as they are. gcloud waits until the new revision is ready.
set -euo pipefail
: "${SHA:?}" "${REGION:?}" "${REGISTRY:?}"

service=$1
image="${REGISTRY}/$2:${SHA}"
context=$3

docker build --provenance=false --sbom=false -t "$image" "$context"
docker push "$image"

gcloud run services update "$service" --region "$REGION" --image "$image" --quiet

# A rollback pins traffic to an old revision, so a new one would get none.
if ! gcloud run services describe "$service" --region "$REGION" --format=json |
  jq -e '.spec.traffic | any(.latestRevision == true and .percent == 100)' >/dev/null; then
  echo "::warning title=${service} traffic was pinned::Traffic was pinned to an older revision (rollback?). Sending 100% to the new revision."
  gcloud run services update-traffic "$service" --region "$REGION" --to-latest --quiet
fi

revision=$(gcloud run services describe "$service" --region "$REGION" \
  --format='value(status.latestReadyRevisionName)')
echo "Deployed ${service}: revision ${revision} (${image})"
echo "revision=${revision}" >>"$GITHUB_OUTPUT"
echo "- **${service}**: revision \`${revision}\` from \`${SHA:0:7}\`" >>"$GITHUB_STEP_SUMMARY"
