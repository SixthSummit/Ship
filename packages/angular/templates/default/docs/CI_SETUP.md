# CI/CD Setup

This document describes the Continuous Integration (CI) and Continuous Deployment (CD) setup for your ShipAngular application.

## Overview

The project includes comprehensive GitHub Actions workflows for:

- **Continuous Integration** - Automated testing, linting, and builds
- **Security Scanning** - Dependency audits and license checks
- **Dependency Management** - Automated update notifications
- **GCP Deployment** - Automated deployment to Google Cloud App Engine

## Workflow Files

### `.github/workflows/ci.yml` - Main CI Pipeline

The main CI workflow runs on every push and pull request to `main` and `dev` branches.

**Jobs:**

| Job                | Description                                                          |
| ------------------ | -------------------------------------------------------------------- |
| `check-skip`       | Checks for `[skip ci]` in commit messages                            |
| `lint-and-format`  | Runs Angular ESLint, ShipAngular rules, Biome, and markup formatting |
| `type-check`       | TypeScript compilation validation                                    |
| `build`            | Production build verification                                        |
| `test`             | Unit tests with coverage                                             |
| `security`         | pnpm audit for vulnerabilities                                       |
| `e2e-health-check` | Basic application health verification                                |
| `ci-summary`       | Aggregated status report                                             |

**Features:**

- Concurrency control to cancel redundant runs
- Skip CI support with `[skip ci]` in commit message
- Parallel job execution for faster feedback
- Build artifact retention

### `.github/workflows/security.yml` - Security Scanning

Runs security checks daily and on pushes to `main`.

**Jobs:**

| Job                | Description                     |
| ------------------ | ------------------------------- |
| `dependency-scan`  | pnpm audit for vulnerabilities  |
| `license-check`    | License compliance verification |
| `bundle-analysis`  | Production bundle size analysis |
| `security-summary` | Aggregated security status      |

### `.github/workflows/dependency-update.yml` - Dependency Management

Runs weekly (Mondays 9 AM UTC) to check for outdated packages.

**Features:**

- Automated outdated dependency report
- Angular version checking
- GitHub issue creation for updates
- Manual trigger support via `workflow_dispatch`

### `.github/workflows/deploy.yml` - GCP Deployment

Deploys to Google Cloud App Engine with environment support.

**Deployment Strategy:**

| Trigger        | Environment                  |
| -------------- | ---------------------------- |
| Push to `dev`  | Staging                      |
| Push to `main` | Production                   |
| Manual trigger | Choose staging or production |

**Jobs:**

| Job                     | Description                                   |
| ----------------------- | --------------------------------------------- |
| `determine-environment` | Sets environment based on trigger             |
| `pre-deploy-tests`      | Runs full test suite before deployment        |
| `build`                 | Production build                              |
| `deploy`                | App Engine deployment to selected environment |
| `verify-deployment`     | Post-deployment health check                  |
| `deploy-summary`        | Deployment status report                      |

### `.github/workflows/tests.yml` - Reusable Test Workflow

A reusable workflow that can be called by other workflows.

### `.github/workflows/setup.yml` - Shared Setup

A reusable setup workflow for consistent environment configuration.

## Available Scripts

### Development Scripts

```bash
# Start development server
pnpm start

# Run tests in watch mode
pnpm test:watch

# Run tests once
pnpm test

# Run tests with coverage
pnpm test:coverage
```

### Code Quality Scripts

```bash
# Type checking
pnpm type-check

# Linting
pnpm lint

# Linting with auto-fix
pnpm lint:fix

# Format code
pnpm format

# Check code formatting
pnpm format:check
```

### CI Scripts

```bash
# Run all CI checks locally
pnpm run ci
```

## GCP App Engine Deployment Setup

### Prerequisites

1. **GCP Projects**: Create projects at [console.cloud.google.com](https://console.cloud.google.com)
   - **Staging**: `your-project-staging`
   - **Production**: `your-project-prod`
   - (Or use a single project with different App Engine services)
2. **App Engine**: Enable App Engine in both projects
3. **Service Accounts**: Create service accounts with App Engine Admin role for each project

### Configuration Steps

1. **Create Service Accounts** (for each environment):
   - Go to IAM & Admin > Service Accounts
   - Create a new service account
   - Grant "App Engine Admin" and "Cloud Build Service Account" roles
   - Generate a JSON key

2. **Configure GitHub Secrets**:
   - Go to your repository Settings > Secrets > Actions
   - Add `APP_ENGINE_CREDENTIALS_STAGING` with the staging JSON key
   - Add `APP_ENGINE_CREDENTIALS_PRODUCTION` with the production JSON key

3. **Configure GitHub Environments** (optional but recommended):
   - Go to Settings > Environments
   - Create `staging` environment
   - Create `production` environment
   - Add required reviewers to production for approval gates

4. **Update Workflow Configuration**:
   - Edit `.github/workflows/deploy.yml`
   - Update `GCP_PROJECT_ID_STAGING` with your staging project ID
   - Update `GCP_PROJECT_ID_PRODUCTION` with your production project ID

5. **Configure `app.yaml`**:
   - Update the dist paths to match your project name
   - Adjust instance scaling settings as needed

### Required GitHub Secrets

| Secret Name                         | Description                             |
| ----------------------------------- | --------------------------------------- |
| `APP_ENGINE_CREDENTIALS_STAGING`    | Service account JSON key for staging    |
| `APP_ENGINE_CREDENTIALS_PRODUCTION` | Service account JSON key for production |

### Package installation

Ship packages are installed from public npmjs. No GitHub Packages token is needed. Deployment credentials remain specific to your own application infrastructure.

### Deployment Methods

**Automatic Deployment:**

```bash
# Deploy to staging
git push origin dev

# Deploy to production
git push origin main
```

**Manual Deployment:**

1. Go to Actions > "Deploy to GCP"
2. Click "Run workflow"
3. Select environment (staging or production)
4. Click "Run workflow"

## Local Development

### Prerequisites

- Node.js 20.x
- pnpm 10.8.1

### Setup

```bash
# Install dependencies
pnpm install

# Run all checks locally
pnpm run ci
```

### Pre-commit Checklist

Before committing code, ensure:

1. ✅ TypeScript compiles without errors (`pnpm type-check`)
2. ✅ ESLint passes (`pnpm lint`)
3. ✅ Code is properly formatted (`pnpm format:check`)
4. ✅ All tests pass (`pnpm test`)
5. ✅ Application builds successfully (`pnpm build-prod`)

## Skip CI

To skip CI on a commit, include `[skip ci]` or `[ci skip]` in the commit message:

```bash
git commit -m "docs: update readme [skip ci]"
```

## Concurrency Control

All workflows use concurrency groups to:

- Cancel redundant workflow runs
- Prevent parallel deployments
- Save CI minutes

## Troubleshooting

### Common Issues

**ESLint Errors**

- Run `pnpm lint:fix` to auto-fix many issues
- Check Angular component/directive naming conventions
- Ensure proper TypeScript types

**Formatting/import issues**

- Run `pnpm format` for Biome-owned TypeScript/JSON and Prettier-owned HTML/SCSS
- Run `pnpm imports:fix` to organize TypeScript imports
- Check `biome.json` and the formatter globs in `package.json` for intentional exclusions

**Test Failures**

- Check test setup in `src/test-setup.ts`
- Ensure all dependencies are mocked properly
- Verify Angular testing module configuration

**Build Failures**

- Check for missing dependencies
- Verify environment configuration
- Check for TypeScript compilation errors

**Deployment Failures**

- Verify `APP_ENGINE_CREDENTIALS` secret is set correctly
- Check `app.yaml` configuration
- Ensure GCP project has App Engine enabled
- Review App Engine logs in GCP Console

### Getting Help

- Check the [Angular Testing Guide](https://angular.io/guide/testing)
- Review [Vitest Documentation](https://vitest.dev/)
- Consult [ESLint Rules](https://eslint.org/docs/rules/)
- Review [GCP App Engine Documentation](https://cloud.google.com/appengine/docs)
