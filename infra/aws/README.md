# Deploying Veyra to AWS

One CloudFormation stack (`cloudformation.yml`) plus two scripts. Everything is served from a single
CloudFront HTTPS domain, so there is no CORS setup and no certificate to manage for a first launch.

```text
                    ┌────────────── CloudFront (https://dxxxx.cloudfront.net) ──────────────┐
  shopper ───────▶  │  /*  → S3 frontend bucket (React build)                                │
                    │  /media/* → S3 media bucket (product images, private, via OAC)          │
                    │  /api/*   → Application Load Balancer                                  │
                    └──────────────────────────────┬─────────────────────────────────────────┘
                                                   ▼
                              ECS Fargate: backend (FastAPI, autoscales on CPU)
                                │        │            │ Service Connect
                     RDS PostgreSQL   MongoDB      ai-service (FastAPI + Claude)
                     (users, orders,  (Atlas or
                      tickets)         DocumentDB)
```

| Piece | AWS service | Notes |
|---|---|---|
| Frontend | S3 + CloudFront | private bucket, Origin Access Control, SPA fallback to `index.html` |
| API + ML | ECS Fargate (0.5 vCPU / 1 GB) behind an ALB | models train in-process; first dashboard load takes a few seconds |
| AI service | ECS Fargate, internal only | reached as `http://ai-service:8000` via ECS Service Connect |
| PostgreSQL | RDS for PostgreSQL 17, `db.t4g.micro`, encrypted, 7-day backups | snapshot kept if the stack is deleted |
| MongoDB | **MongoDB Atlas on AWS** (free M0 works) or Amazon DocumentDB | passed in as `MongoUri` |
| Product images | S3 (`media/products/...`), uploaded by the backend task role | |
| Secrets | Secrets Manager: JWT secret and DB password are generated; Mongo URI, SMTP and Anthropic keys are stored | injected into containers, never in task definitions |
| Logs / metrics | CloudWatch Logs (30 days) + Container Insights | |
| Email (OTP) | Amazon SES SMTP (optional) | without it, OTP codes appear only in CloudWatch logs |

## Before you start

- AWS CLI v2 logged in to your account (`aws sts get-caller-identity` works), Docker, Node 20+.
- A MongoDB database. Easiest: create a free **MongoDB Atlas** cluster in the same region and allow access
  from anywhere (or from your VPC with peering). For **DocumentDB**, create the cluster in the same VPC,
  allow port 27017 from the stack's `ServiceSecurityGroupId`, and use a URI ending in
  `?tls=true&tlsCAFile=global-bundle.pem&retryWrites=false` (bake the CA bundle into the backend image).
- Your VPC id and two subnets in different availability zones (`aws ec2 describe-subnets`). The default
  VPC's public subnets are fine to start; tasks get a public IP so no NAT gateway is needed.

## Deploy

```bash
cp infra/aws/params.example.json infra/aws/params.json   # fill in VPC, subnets, MongoUri (gitignored)
./infra/aws/deploy.sh ap-south-1 veyra-prod infra/aws/params.json
./infra/aws/seed.sh  ap-south-1 veyra-prod               # once: catalog, demo accounts, demo history
```

`deploy.sh` builds and pushes both images to ECR (tagged with the git commit), creates/updates the stack,
uploads the frontend to S3, invalidates CloudFront and waits for the backend to become healthy. Re-run it
for every release; failed deployments roll back automatically (ECS deployment circuit breaker).

Use `./infra/aws/seed.sh ap-south-1 veyra-prod --no-history` for a clean store without demo orders.

## After deploying

- **Google sign-in:** add the CloudFront URL to the OAuth client's *Authorised JavaScript origins*, then
  set `GoogleClientId` in `params.json` and re-deploy.
- **OTP emails:** verify your sender address/domain in SES, create SMTP credentials, set `SmtpHost`
  (e.g. `email-smtp.ap-south-1.amazonaws.com`), `SmtpUser`, `SmtpPass`, `MailFrom`, and re-deploy.
  New SES accounts are in the sandbox: request production access to email any customer.
- **Custom domain:** add an ACM certificate (in `us-east-1`) and `Aliases` to the CloudFront distribution.
- **Admin password:** change `admin@shop.local` / `admin123` (or remove the demo accounts) before going public.

## Cost (approximate, ap-south-1, on-demand)

| Item | ~ USD / month |
|---|---|
| 2 Fargate tasks (0.5 vCPU, 1 GB) | 30 |
| Application Load Balancer | 18 |
| RDS db.t4g.micro + 20 GB | 15 (free tier eligible for 12 months) |
| CloudFront, S3, Secrets Manager, CloudWatch | 3–5 at low traffic |
| MongoDB Atlas M0 | 0 (DocumentDB starts around 60) |

Delete everything with `aws cloudformation delete-stack --stack-name veyra-prod` (the database is kept as a
final snapshot; S3 buckets must be emptied first; ECR repositories created by `deploy.sh` are deleted separately).

## Hardening for real production traffic

- Move tasks and the database to private subnets with a NAT gateway (or VPC endpoints for ECR, S3, Logs,
  Secrets Manager) and set `AssignPublicIp: DISABLED`.
- Put AWS WAF on CloudFront (rate limiting replaces the in-process limiter when running several tasks).
- Use RDS Multi-AZ, and Redis (ElastiCache) if you scale the backend beyond a few tasks so the ML cache is shared.
