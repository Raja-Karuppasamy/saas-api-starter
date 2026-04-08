# Jobs & CronJobs Guide

## What Are Jobs?

Job: Runs a task once until completion, then stops.

Key difference from Deployment:
- Deployment: Keeps pods running forever (restarts on exit)
- Job: Runs pod once, stops when task completes

## Job Lifecycle

1. Job created
2. Job creates Pod
3. Pod runs task
4. Task completes (exit code 0) → Job marked "Complete"
   OR Task fails (exit code != 0) → Job retries (up to backoffLimit)
5. Job keeps completed pod for logs
6. Manual cleanup or TTL

## Basic Job Example

apiVersion: batch/v1
kind: Job
metadata:
  name: hello-job
spec:
  template:
    spec:
      containers:
      - name: task
        image: busybox
        command: ["echo", "Hello!"]
      restartPolicy: Never
  backoffLimit: 3

## Parallel Jobs

spec:
  completions: 5
  parallelism: 2

Runs 2 pods at a time until 5 total complete.

## CronJobs (Scheduled Tasks)

Creates Jobs on a schedule (like cron).

apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup-job
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: postgres:15
            command: ["pg_dump"]
          restartPolicy: Never

## Cron Schedule Format

* * * * *
│ │ │ │ └─ Day of week (0-6)
│ │ │ └─── Month (1-12)
│ │ └───── Day of month (1-31)
│ └─────── Hour (0-23)
└───────── Minute (0-59)

Examples:
- */5 * * * * - Every 5 minutes
- 0 2 * * * - Daily at 2 AM
- 0 0 * * 0 - Weekly Sunday midnight
- 0 0 1 * * - Monthly on 1st

## Real-World Use Cases

Jobs (One-Time):
- Database migrations
- Data processing
- Image optimization
- File uploads processing

CronJobs (Scheduled):
- Daily backups (0 2 * * *)
- Hourly log cleanup (0 * * * *)
- Weekly reports (0 0 * * 0)
- Monthly billing (0 0 1 * *)

## Important Settings

restartPolicy (REQUIRED):
- Never - Don't restart (creates new pod)
- OnFailure - Restart same pod
- Always - NOT ALLOWED in Jobs

backoffLimit: 3 - Retry up to 3 times
activeDeadlineSeconds: 300 - Kill after 5 minutes
ttlSecondsAfterFinished: 3600 - Auto-delete after 1 hour

CronJob Settings:
- concurrencyPolicy: Forbid - Don't run if previous still running
- successfulJobsHistoryLimit: 3 - Keep last 3 successful
- failedJobsHistoryLimit: 1 - Keep last 1 failed

## Jobs vs Deployments vs StatefulSets

Deployment: Long-running app, never completes
StatefulSet: Stateful app, never completes
Job: One-time task, completes and stops

## Best Practices

✅ Always set backoffLimit
✅ Use ttlSecondsAfterFinished for auto-cleanup
✅ Set activeDeadlineSeconds to prevent infinite runs
✅ Use concurrencyPolicy: Forbid for non-overlapping CronJobs
✅ Include resource limits

❌ Don't use restartPolicy: Always
❌ Don't forget to clean up completed jobs
❌ Don't run heavy workloads without resource limits

## QuickAI Examples

Database Migration:
apiVersion: batch/v1
kind: Job
metadata:
  name: quickai-migration-v2
spec:
  template:
    spec:
      containers:
      - name: migrate
        image: rajajeba/saas-api:latest
        command: ["npm", "run", "migrate"]
        envFrom:
        - secretRef:
            name: quickai-secrets
      restartPolicy: Never
  backoffLimit: 2

Daily Analytics:
apiVersion: batch/v1
kind: CronJob
metadata:
  name: daily-analytics
spec:
  schedule: "0 8 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: analytics
            image: rajajeba/saas-api:latest
            command: ["node", "scripts/generate-report.js"]
          restartPolicy: Never
