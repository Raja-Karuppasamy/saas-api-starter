# ConfigMaps & Secrets Management Guide

## When to Use Each

### ConfigMap (Non-Sensitive)
Use for:
- Application settings (NODE_ENV, LOG_LEVEL)
- Feature flags (ENABLE_FEATURE_X)
- External endpoints (REDIS_HOST, API_BASE_URL)
- Timeouts, limits, thresholds
- Anything you'd commit to Git

### Secrets (Sensitive)
Use for:
- API keys (OPENAI_API_KEY, STRIPE_SECRET_KEY)
- Database passwords (DATABASE_URL)
- TLS certificates
- OAuth tokens
- SSH keys
- Anything you'd never commit to Git

## Three Ways to Use ConfigMaps

### Method 1: All Keys as Env Vars (envFrom)
```yaml
envFrom:
- configMapRef:
    name: quickai-config
```
**Pros:** Simple, all keys loaded automatically
**Cons:** Potential naming conflicts, cluttered environment

### Method 2: Individual Env Vars (env)
```yaml
env:
- name: NODE_ENV
  valueFrom:
    configMapKeyRef:
      name: quickai-config
      key: NODE_ENV
```
**Pros:** Explicit, can rename keys, selective loading
**Cons:** More verbose

### Method 3: Volume Mount (files)
```yaml
volumeMounts:
- name: config-volume
  mountPath: /etc/config
volumes:
- name: config-volume
  configMap:
    name: quickai-config
```
**Pros:** Auto-reloads without pod restart, good for config files
**Cons:** App must read files (not env vars)

## Secret Best Practices

### Use stringData (Not data)
```yaml
# Good ✅
stringData:
  password: mysecret123

# Bad ❌ (manual base64 encoding)
data:
  password: bXlzZWNyZXQxMjM=
```

### Organize by Purpose
```yaml
# Good ✅ - Separate secrets
- database-credentials
- api-keys
- tls-certificates

# Bad ❌ - One giant secret
- app-secrets (everything in one)
```

### Never Commit Secrets to Git
```bash
# In .gitignore
*.env
secrets.yaml
*-secret.yaml
```

### Use External Secret Management (Production)
- Google Secret Manager
- AWS Secrets Manager
- HashiCorp Vault
- Sealed Secrets (encrypts secrets in Git)

## Updating Config Without Downtime

### For Environment Variables:
```bash
# Update ConfigMap
kubectl patch configmap quickai-config --patch '{"data":{"LOG_LEVEL":"debug"}}'

# Restart pods (rolling restart, zero downtime)
kubectl rollout restart deployment api
```

### For Volume-Mounted Files:
ConfigMaps mounted as volumes auto-update within ~60 seconds.
No pod restart needed IF your app watches the file.

## ConfigMap vs Secrets Comparison

| Feature | ConfigMap | Secret |
|---------|-----------|---------|
| Encoding | Plain text | Base64 |
| Encryption at rest | No (default) | Optional |
| Use case | Non-sensitive | Sensitive |
| Size limit | 1MB | 1MB |
| Auto-reload (volumes) | Yes | Yes |
| Auto-reload (env vars) | No | No |

## Security Warnings

⚠️ **Secrets are NOT encrypted by default!**
- Only base64 encoded (easily decoded)
- Visible to anyone with `kubectl get secret` access
- Enable encryption at rest in production

⚠️ **RBAC is critical!**
- Limit who can read secrets
- Use separate namespaces for different teams
- Service accounts should have minimal permissions

⚠️ **Never log secrets!**
```javascript
// Bad ❌
console.log('API Key:', process.env.OPENAI_API_KEY)

// Good ✅
console.log('API Key:', '***')
```

## Real Example: QuickAI

### Current Setup:
```yaml
# Secrets (quickai-secrets)
- DATABASE_URL
- OPENAI_API_KEY
- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- STRIPE_PRICE_ID

# ConfigMap (quickai-config)
- NODE_ENV
- LOG_LEVEL
- API_VERSION
- Feature flags
```

### Used in Deployment:
```yaml
spec:
  containers:
  - name: api
    envFrom:
    - secretRef:
        name: quickai-secrets
    - configMapRef:
        name: quickai-config
```

All config loaded as environment variables automatically!
