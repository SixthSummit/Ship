# Phase 08: Framework migration tooling and release

The framework provides migration tools and compatibility boundaries. Application
migration records, inventories, rollout cohorts, and deployment evidence belong
in application repositories.

## Framework responsibilities

- Generate structural client providers, resources, mutations, auth bindings, and
  deterministic import changes where the transformation is mechanical.
- Report manual mappings, custom serializers, request policies, transport usage,
  and copied source without guessing operation IDs or discarding error metadata.
- Exercise migration tools against synthetic fixtures owned by this repository.
- Verify packed artifacts, public types, browser/SSR conformance, bundle limits,
  and release metadata before publication.
- Retain documented compatibility surfaces until an explicit deprecation and
  breaking-release decision permits removal.

## Application integration

Use the [migration playbook](../CLIENT_MIGRATION_PLAYBOOK.md) to characterize
legacy behavior, pin exact versions, and test an application independently.
Application deployment or rollback approval is not implied by a framework release.

## Release mechanics

See [the release guide](../../../RELEASE_GUIDE.md) for dev snapshots and stable
releases. See [testing gates](../TESTING_GATES.md) for framework verification.
