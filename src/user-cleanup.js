// Directus-side object handling for the user deletion sequence.
//
// Objects created by the deleted user are either transferred to a
// co-author (items with an authors list keep their remaining co-authors as
// owner), to a fallback user chosen in the deletion dialog ("orphaned"
// objects without co-authors), or — when no fallback was chosen — undeployed
// (deployments, via the undeploy-on-delete hook of the kubernetes endpoint)
// and removed.

// The collections offered in the deletion dialog, with their ownership
// semantics:
// - authorsField: m2m field naming the users with co-rights; a remaining
//   co-author becomes the new owner
// - userM2MFields: m2m fields referencing users whose junction rows must be
//   pruned when the user is deleted
// - userField: field naming the user the object belongs to — either a plain
//   m2o field or an m2m through a junction (gpu_reservations.user is an m2m;
//   reservations are deleted with the user, not transferred — they have no
//   co-author concept)
export const USER_COLLECTIONS = [
  { collection: 'deployments', authorsField: 'authors', userM2MFields: ['authors'] },
  { collection: 'results', authorsField: 'authors', userM2MFields: ['authors'] },
  { collection: 'courses', authorsField: 'authors', userM2MFields: ['authors', 'members', 'collaborators'] },
  { collection: 'course_sections' },
  { collection: 'external_materials' },
  { collection: 'volumes' },
  { collection: 'gpu_reservations', userField: 'user', userM2MFields: ['user'], deleteOnly: true }
]

export const DEFAULT_COLLECTION_SCOPE = USER_COLLECTIONS.map(c => c.collection)

export function isKnownCollection (collection) {
  return USER_COLLECTIONS.some(c => c.collection === collection)
}

/**
 * Builds the filter matching "objects of the user" for a userField that is
 * either a plain m2o (filter the field directly) or an m2m through a
 * junction (filter through the junction's user FK — a direct _eq would
 * compare the junction's integer primary key against the user uuid and fail
 * with "invalid input syntax for type integer: NaN").
 */
export function buildUserScopeFilter (schema, collection, userField, userId) {
  const m2m = schema?.relations?.find(r =>
    r.related_collection === collection &&
    r.meta?.one_field === userField &&
    r.meta?.many_collection
  )
  if (m2m) {
    return { [userField]: { directus_users_id: { _eq: userId } } }
  }
  return { [userField]: { _eq: userId } }
}

/**
 * Resolves the junction collection and its user field for an m2m field
 * (e.g. the `authors` field of `deployments`) from the Directus schema, so
 * junction naming never has to be hardcoded.
 */
export function findUserJunction (schema, collection, field) {
  const relations = schema?.relations || []
  const relation = relations.find(r =>
    (r.related_collection === collection && r.meta?.one_field === field) ||
    (r.collection === collection && r.field === field && r.meta?.many_collection)
  )
  if (!relation) return null
  const junctionCollection = relation.meta?.many_collection || relation.collection
  const userField = relation.meta?.junction_field || 'directus_users_id'
  // The junction's FK field pointing back to the parent item (e.g.
  // "deployments_id" on "deployments_authors")
  const itemRelation = relations.find(r =>
    r.collection === junctionCollection && r.related_collection === collection
  )
  const itemField = itemRelation?.field
  return { junctionCollection, userField, itemField }
}

/**
 * Handles all objects of the deleted user and prunes their remaining user
 * references from junction tables.
 *
 * Every object is either transferred (to the first remaining co-author, or
 * to the fallback recipient when its type was requested in the scope) or
 * deleted — nothing keeps referencing the deleted account. Runs with
 * system accountability: the orchestrating admin must be able to clean up
 * objects they could not necessarily read or modify themselves.
 * Every operation is idempotent — items already handled on an earlier run
 * simply no longer match.
 *
 * Returns a step report: per-collection counters and per-object errors.
 */
export async function cleanupUserObjects ({ services, schema, logger, logPrefix, directusUser, scope, transferTo }) {
  const report = {
    transferred: {},
    deletedItems: {},
    errors: []
  }
  const { ItemsService } = services

  for (const entry of USER_COLLECTIONS) {
    const { collection, authorsField, userField, deleteOnly } = entry
    const service = new ItemsService(collection, { schema, accountability: null })

    let items
    try {
      items = await service.readByQuery({
        filter: userField
          ? {
              _or: [
                { user_created: { _eq: directusUser.id } },
                buildUserScopeFilter(schema, collection, userField, directusUser.id)
              ]
            }
          : { user_created: { _eq: directusUser.id } },
        fields: [
          'id',
          // junction row ids plus the referenced users, needed to find the
          // remaining co-authors and prune the deleted user's rows
          ...(authorsField ? [`${authorsField}.id`, `${authorsField}.directus_users_id.id`] : [])
        ],
        limit: -1
      }) || []
    } catch (err) {
      report.errors.push({ collection, message: `Failed to read items: ${err.message}` })
      continue
    }

    const itemErrors = []
    for (const item of items) {
      try {
        // gpu reservations are always removed with the user (they are
        // personal by nature — reserved for and created by them)
        if (deleteOnly) {
          await service.deleteOne(item.id)
          report.deletedItems[collection] = (report.deletedItems[collection] || 0) + 1
          continue
        }

        const junctionRows = authorsField ? (item[authorsField] || []) : []
        const coAuthors = junctionRows
          .map(row => row?.directus_users_id?.id)
          .filter(id => id && id !== directusUser.id)

        let newOwner = coAuthors[0]
        let transferKind = 'co_author'
        if (!newOwner) {
          // Fallback transfer only when the type was explicitly requested
          // in the scope and a recipient was chosen — otherwise the object
          // is undeployed (deployments, via the kubernetes endpoint's
          // undeploy-on-delete hook) and removed
          if (!transferTo || !scope.includes(collection)) {
            await service.deleteOne(item.id)
            report.deletedItems[collection] = (report.deletedItems[collection] || 0) + 1
            continue
          }
          newOwner = transferTo
          transferKind = 'fallback'
        }

        await service.updateOne(item.id, { user_created: newOwner })
        // The overview and the access checks work off the authors junction,
        // not user_created — a fallback recipient who is not yet an author
        // would own an item that displays no name and that they could not
        // edit as author. With remaining co-authors this is unnecessary: the
        // new owner is the first of them and thus already an author.
        if (transferKind === 'fallback' && authorsField) {
          const junction = findUserJunction(schema, collection, authorsField)
          if (junction?.itemField) {
            const junctionService = new ItemsService(junction.junctionCollection, { schema, accountability: null })
            await junctionService.createOne({
              [junction.itemField]: item.id,
              [junction.userField]: newOwner
            })
          }
        }
        report.transferred[collection] = (report.transferred[collection] || 0) + 1
        if (logger) {
          logger.info(`${logPrefix}Transferred ${collection} ${item.id} to ${newOwner} (${transferKind})`)
        }
      } catch (err) {
        itemErrors.push({ collection, id: item.id, message: err.message })
      }
    }
    report.errors.push(...itemErrors)
  }

  // Prune the deleted user's junction rows across all known collections
  // — including items owned by other users (membership lists etc. must not
  // dangle-reference the deleted account)
  for (const entry of USER_COLLECTIONS) {
    for (const field of entry.userM2MFields || []) {
      const junction = findUserJunction(schema, entry.collection, field)
      if (!junction) {
        report.errors.push({
          collection: entry.collection,
          message: `No junction collection found for m2m field ${field}`
        })
        continue
      }
      const junctionService = new ItemsService(junction.junctionCollection, {
        schema,
        accountability: null
      })
      try {
        await junctionService.deleteByQuery({
          filter: { [junction.userField]: { _eq: directusUser.id } }
        })
      } catch (err) {
        report.errors.push({
          collection: entry.collection,
          message: `Failed to prune ${junction.junctionCollection}: ${err.message}`
        })
      }
    }
  }

  return report
}
