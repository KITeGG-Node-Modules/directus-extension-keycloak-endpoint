# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-26

Initial documented release.

### Added

- User administration endpoint `/keycloak/users`, restricted to Directus
  `admin` users or Keycloak `management` group members:
  - Find users (`GET /keycloak/users`) with Keycloak query params
  - Get a single user (`GET /keycloak/users/<ID>`)
  - Create a user (`POST /keycloak/users`) with a one-time password and an
    optionally linked Directus user (`skipDirectusUser`)
  - Update a user (`PATCH /keycloak/users/<ID>`)
  - Reset a password (`POST /keycloak/users/<ID>/password`)
- Cross-system user deletion (`DELETE /keycloak/users/<ID>`) in dependency
  order — JupyterHub (server stop, hub user, home volume), Directus (object
  transfer/undeploy, junction cleanup), Keycloak — with an idempotent,
  per-step report for safe retries.
- Role ranking enforcement for deletion (staff < management < admin).
- `lastLogin` (via a Keycloak last-login event listener) and `lastSeen`
  (Directus `last_access`) in user results.
- Group value endpoints: `GET /keycloak/associations`,
  `GET /keycloak/types`, `GET /keycloak/profiles`.

[Unreleased]: https://github.com/KITeGG-Node-Modules/directus-extension-keycloak-endpoint/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/KITeGG-Node-Modules/directus-extension-keycloak-endpoint/releases/tag/v1.0.0
