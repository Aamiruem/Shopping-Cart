#!/usr/bin/env bash
# Runs the seed script once as a one-off ECS task (catalog, demo accounts, 6 months of demo history).
#   ./infra/aws/seed.sh <region> <stack-name> [extra seed args, e.g. --no-history]
set -euo pipefail

REGION=${1:?region}
STACK=${2:?stack name}
shift 2

output() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

COMMAND=$(printf '"%s",' python -m scripts.seed "$@")
TASK=$(aws ecs run-task --region "$REGION" --cluster "$(output ClusterName)" --launch-type FARGATE \
  --task-definition "$(output BackendTaskDefinitionArn)" \
  --network-configuration "awsvpcConfiguration={subnets=[$(output SeedTaskSubnets)],securityGroups=[$(output ServiceSecurityGroupId)],assignPublicIp=ENABLED}" \
  --overrides "{\"containerOverrides\":[{\"name\":\"backend\",\"command\":[${COMMAND%,}]}]}" \
  --query 'tasks[0].taskArn' --output text)

echo "Seeding (task $TASK) - this takes about a minute..."
aws ecs wait tasks-stopped --region "$REGION" --cluster "$(output ClusterName)" --tasks "$TASK"
EXIT=$(aws ecs describe-tasks --region "$REGION" --cluster "$(output ClusterName)" --tasks "$TASK" --query 'tasks[0].containers[0].exitCode' --output text)
echo "Seed finished with exit code $EXIT (logs: CloudWatch group /ecs/$STACK... stream prefix 'backend')"
[ "$EXIT" = "0" ]
