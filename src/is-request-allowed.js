import { TYPES } from './constants.js'
import { isNotFound } from './is-not-found.js'

async function isRequestAllowed (ctx) {
  const {client, req, userGroups} = ctx
  let subjectTypeGroup

  // The target's Keycloak account can be missing (stale external_identifier
  // on a provider: keycloak user) — its groups are then unknown and the
  // coarse type check below is skipped; the routes' own rank checks apply
  if (req.params.id) {
    try {
      const {data: subjectGroups} = await client.get(`/users/${req.params.id}/groups`)
      subjectTypeGroup = subjectGroups.find(group => TYPES.includes(group.name))
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }

  if (req.method === 'POST') {
    subjectTypeGroup = {name: req.body.type}
  } else if (req.method === 'PATCH' && req.body.type) {
    subjectTypeGroup = {name: req.body.type}
  }

  const userType = userGroups.find(group => TYPES.includes(group.name))
  const userTypeIndex = TYPES.indexOf(userType ? userType.name : 'admin')
  const subjectTypeIndex = subjectTypeGroup ? TYPES.indexOf(subjectTypeGroup.name) : -1

  if (userTypeIndex < subjectTypeIndex) throw new Error('forbidden')
}

export {
  isRequestAllowed
}
