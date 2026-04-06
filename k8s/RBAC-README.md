# QuickAI RBAC Setup

## Service Accounts

### 1. `default` (Used by QuickAI app)
- **Purpose:** Running the application
- **Permissions:** Minimal (only API discovery)
- **Usage:** Automatically assigned to pods

### 2. `quickai-readonly`
- **Purpose:** Monitoring, dashboards, read-only access
- **Permissions:** 
  - ✅ Read pods, services, deployments
  - ❌ Cannot modify anything
  - ❌ Cannot access secrets
- **Token:** `quickai-readonly-token`

### 3. `quickai-deployer`
- **Purpose:** CI/CD pipelines (GitHub Actions, etc.)
- **Permissions:**
  - ✅ Read pods, services, deployments
  - ✅ Create/update deployments
  - ✅ Rollback deployments
  - ❌ Cannot delete resources
  - ❌ Cannot access secrets
- **Token:** `quickai-deployer-token`

## Security Best Practices

✅ **Principle of Least Privilege:** Each account has ONLY the permissions it needs  
✅ **No Secret Access:** CI/CD cannot read secrets (prevents token leakage)  
✅ **No Delete Permissions:** Prevents accidental deletion  
✅ **Namespace-scoped:** Roles only work in `default` namespace  
