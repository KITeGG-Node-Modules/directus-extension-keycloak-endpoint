# KITeGG Directus Keycloak Endpoint

> User management from within Directus

## API

Endpoint access is restricted to either Directus `admin` users or Keycloak `management` group members.

### Find users

```
GET /keycloak/users
```

You can pass query params as described
[in the Keycloak docs under Users / GET](https://www.keycloak.org/docs-api/18.0/rest-api/#_users_resource).

The results include the login activity dates `lastLogin` and `lastSeen`
(see [Last login and last seen](#last-login-and-last-seen)).

### Create user

Users can only be created by `staff` or `management` group members.

Creating a user sets `enabled` to `true` by default.

The result contains a one-time password to be used for the first login.

The request will also create a directus user linked to the Keycloak Account,
unless `skipDirectusUser: true` is passed in the request body.

``` 
POST /keycloak/users
```

Body (mandatory fields):

```json
{
  "username": "asdf",
  "firstname": "Test",
  "lastname": "User",
  "email": "test@example.asdf",
  "association": "hsm",
  "type": "student"
}
```

Optional additional props:
```json
{
  "enabled": false,
  "skipDirectusUser": true,
  "profiles": [
    "gpu-s",
    "gpu-m",
    "gpu-l"
  ]
}
```

Possible values for `association`:

- `hsm`: HS Mainz
- `hfgo`: HFG Offenbach
- `hst`: HS Trier
- `hfgg`: HFG Gmünd
- `kisd`: KISD

Possible values for `type`:

- `staff`
- `student`
- `management`

Possible values for `profiles`:

- `gpu-s`
- `gpu-m`
- `gpu-l`
- `gpu-xl`

### Get user

This includes associations, type and profiles,
as opposed to the `find` results.

It also includes the login activity dates `lastLogin` and `lastSeen`
(see [Last login and last seen](#last-login-and-last-seen)).

```
GET /keycloak/users/<ID>
```

### Update user

```
PATCH /keycloak/users/<ID>
```

Body (e.g.):
```json
{ "enabled": false }
```

**Note:** Setting `profiles` replaces the existing array value.

### Reset password

Resetting the password will return a new one-time password.

```
POST /keycloak/users/<ID>/password
```

### Remove user

```
DELETE /keycloak/users/<ID>
```

Deletes the user across all three systems in dependency order:

1. **JupyterHub**: stops the running server, deletes the hub user and
   removes the home volume (`claim-<username>`). With KubeSpawner's default
   `delete_pvc = true` the hub itself removes the volume together with the
   user — the explicit deletion is a safety net and treats an already-gone
   volume as success. Requires `JUPYTERHUB_API_URL` and
   `JUPYTERHUB_API_TOKEN` (plus `JUPYTERHUB_NAMESPACE`, default
   `jupyterhub`); without them the step fails loudly instead of silently
   leaving hub users behind.
2. **Directus**: every object of the user is either transferred to a
   remaining co-author, to the fallback user from the options (only for
   types requested in `collections`), or — when neither applies —
   undeployed (via the kubernetes endpoint's undeploy-on-delete hook) and
   removed. Nothing keeps referencing the deleted account. The user's rows
   in the authors/members/collaborators junction tables are pruned, then
   the Directus user is deleted. If this step fails, the Keycloak account
   is left untouched so the deletion can be retried.
3. **Keycloak**: the IdP account (already-deleted is treated as success).

An optional JSON body configures the Directus step:

```json
{
  "collections": ["deployments", "results", "courses",
    "course_sections", "external_materials", "volumes",
    "gpu_reservations", "directus_files"],
  "transferTo": "<directus user id>",
  "deleteJupyterVolume": true
}
```

`collections` lists the types eligible for fallback transfers (default:
all of them; types not listed are deleted instead of transferred).
`transferTo` receives orphaned objects of requested types (without
co-authors; without it they are undeployed and removed), and
`deleteJupyterVolume` disables the home volume deletion when set to
`false`.

Files (`directus_files`) have no co-author concept: when listed in
`collections` with a `transferTo`, they are transferred to the recipient
(`uploaded_by`); otherwise they are deleted from the database **and the
file storage**, including the underlying assets.

Every step is idempotent (already-deleted state counts as success), so the
deletion can simply be re-run after a partial failure. The response carries
a per-step report (`jupyterhub`, `directus`, `keycloak`) with the outcome of
each step, per-object errors, and an overall `success` flag.

#### Who may delete whom

The endpoint enforces the same role ranking as the frontend menus: the
calling user must strictly outrank the target — staff may delete students,
management students and staff, admin anyone. Management deleting management
requires an admin; unknown roles are rejected. Targets without a linked
Directus user have nothing to rank and only their Keycloak account is
removed. The check runs before any destructive step, so bulk deletions are
validated per user.

#### Kubernetes permissions for the volume deletion

The extension runs inside the Directus pod, so the pod's ServiceAccount
needs permission to delete the home-volume PVCs in the JupyterHub namespace.
Apply [`deploy/pvc-delete-rbac.yaml`](deploy/pvc-delete-rbac.yaml) with the
placeholders replaced:

```sh
sed -e 's/<DIRECTUS_NAMESPACE>/<ns>/' \
    -e 's/<DIRECTUS_SERVICEACCOUNT>/<sa>/' \
    deploy/pvc-delete-rbac.yaml | kubectl apply -f -
```

Without this grant the deletion still removes the hub account but fails at
the volume step with `Kubernetes API returned 403: … is forbidden: User
"system:serviceaccount:…" cannot delete resource "persistentvolumeclaims"…`
— the report names the exact ServiceAccount to grant. Apply the role and
re-run the deletion; every earlier step is 404-tolerant.

## Last login and last seen

Both user endpoints (`GET /keycloak/users` and `GET /keycloak/users/<ID>`)
include:

- `lastLogin`: the last login recorded by Keycloak, read from a user
  attribute written by a last-login event listener SPI (see setup below).
  The attribute names `lastLogin` and `lastLoginTime` are recognized; the
  attribute value should be epoch milliseconds or an ISO 8601 date-time and
  is normalized to an ISO 8601 string. `null` if the SPI is not installed or
  the user has not logged in since it was installed.

- `lastSeen`: the `last_access` date of the linked Directus user. Directus
  updates `last_access` on login and on token refresh, so it also reflects
  ongoing activity of logged-in users. `null` if no Directus user is linked
  or the requesting user lacks permission to read other Directus users.

To record `lastLogin`, install a last-login event listener in Keycloak, e.g.
[slemke/keycloak-last-login-event-listener](https://github.com/slemke/keycloak-last-login-event-listener)
or dasniko's
[LastLoginTimeListener](https://github.com/dasniko/keycloak-extensions-demo):
drop the jar into Keycloak's `providers` directory and add the event listener
(`last-login` or `last-login-time`) under *Realm settings → Events → Event
listeners*. Logins before the listener was installed are not recorded.

## Groups

### Associations

Get available association values.

```
GET /keycloak/associations
```

### Types

Get available type values.

```
GET /keycloak/types
```

### Profiles

Get available profile values.

```
GET /keycloak/profiles
```
