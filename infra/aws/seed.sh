#!/usr/bin/env bash
# Creates the store's first admin as a one-off ECS task. scripts.seed refuses to run in production (it would
# publish demo logins and fake orders), so real products are added in the Seller Hub afterwards.
#   ADMIN_EMAIL=you@yourstore.in ADMIN_PASSWORD='...' ./infra/aws/seed.sh <region> <stack-name>
# The password is visible in the task's overrides, so change it after your first login.
set -euo pipefail

REGION=${1:?region}
STACK=${2:?stack name}
: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"
: "${ADMIN_PASSWORD:?set ADMIN_PASSWORD}"

output() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

TASK=$(aws ecs run-task --region "$REGION" --cluster "$(output ClusterName)" --launch-type FARGATE \
  --task-definition "$(output BackendTaskDefinitionArn)" \
  --network-configuration "awsvpcConfiguration={subnets=[$(output SeedTaskSubnets)],securityGroups=[$(output ServiceSecurityGroupId)],assignPublicIp=ENABLED}" \
  --overrides "{\"containerOverrides\":[{\"name\":\"backend\",\"command\":[\"python\",\"-m\",\"scripts.create_admin\"],\"environment\":[{\"name\":\"ADMIN_EMAIL\",\"value\":\"$ADMIN_EMAIL\"},{\"name\":\"ADMIN_PASSWORD\",\"value\":\"$ADMIN_PASSWORD\"}]}]}" \
  --query 'tasks[0].taskArn' --output text)

echo "Creating the admin (task $TASK)..."
aws ecs wait tasks-stopped --region "$REGION" --cluster "$(output ClusterName)" --tasks "$TASK"
EXIT=$(aws ecs describe-tasks --region "$REGION" --cluster "$(output ClusterName)" --tasks "$TASK" --query 'tasks[0].containers[0].exitCode' --output text)
echo "Finished with exit code $EXIT (logs: CloudWatch group /ecs/$STACK... stream prefix 'backend')"
[ "$EXIT" = "0" ]
