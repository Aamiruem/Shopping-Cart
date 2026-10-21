#!/usr/bin/env bash
# Builds, pushes and deploys the whole Veyra stack to AWS.
#
#   ./infra/aws/deploy.sh <region> <stack-name> <params-file>
#   e.g. ./infra/aws/deploy.sh ap-south-1 veyra-prod infra/aws/params.json
#
# params-file is a CloudFormation parameters JSON (copy params.example.json). Requires: aws CLI v2,
# docker, node 20+. Creates real, billable AWS resources - see infra/aws/README.md for costs.
set -euo pipefail

REGION=${1:?region}
STACK=${2:?stack name}
PARAMS=${3:?params file}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
TAG=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)

echo "==> 1/5 Container images ($TAG)"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
for svc in backend ai-service; do
  repo="$STACK-$svc"
  aws ecr describe-repositories --region "$REGION" --repository-names "$repo" >/dev/null 2>&1 \
    || aws ecr create-repository --region "$REGION" --repository-name "$repo" --image-scanning-configuration scanOnPush=true >/dev/null
  docker build --platform linux/amd64 -t "$REGISTRY/$repo:$TAG" "$ROOT/$svc"
  docker push "$REGISTRY/$repo:$TAG"
done

echo "==> 2/5 CloudFormation stack $STACK"
OVERRIDES=$(node -e '
  const p = require(process.argv[1]);
  const extra = { BackendImage: process.argv[2], AiServiceImage: process.argv[3] };
  const all = Object.fromEntries(p.map((x) => [x.ParameterKey, x.ParameterValue]));
  Object.assign(all, extra);
  console.log(Object.entries(all).map(([k, v]) => `${k}=${v}`).join("\n"));
' "$(cd "$(dirname "$PARAMS")" && pwd)/$(basename "$PARAMS")" "$REGISTRY/$STACK-backend:$TAG" "$REGISTRY/$STACK-ai-service:$TAG")
mapfile -t OVERRIDE_ARGS <<< "$OVERRIDES"
aws cloudformation deploy --region "$REGION" --stack-name "$STACK" \
  --template-file "$ROOT/infra/aws/cloudformation.yml" \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides "${OVERRIDE_ARGS[@]}"

output() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

echo "==> 3/5 Frontend"
( cd "$ROOT/frontend" && npm ci && VITE_API_URL="" npm run build )
aws s3 sync "$ROOT/frontend/dist" "s3://$(output FrontendBucketName)" --delete --region "$REGION" \
  --cache-control "public, max-age=31536000, immutable" --exclude index.html
aws s3 cp "$ROOT/frontend/dist/index.html" "s3://$(output FrontendBucketName)/index.html" --region "$REGION" \
  --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id "$(output DistributionId)" --paths "/index.html" >/dev/null

echo "==> 4/5 Waiting for the backend service to be stable"
aws ecs wait services-stable --region "$REGION" --cluster "$(output ClusterName)" --services backend

echo "==> 5/5 Done"
echo "Store:  $(output SiteUrl)"
echo "Seed demo data once with:  ./infra/aws/seed.sh $REGION $STACK"
