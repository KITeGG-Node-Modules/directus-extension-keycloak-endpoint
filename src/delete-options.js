import { DEFAULT_COLLECTION_SCOPE, isKnownCollection } from './user-cleanup.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Defaults for the deletion sequence:
// - all known collections are in scope (i.e. eligible for fallback
//   transfers); objects of types not requested are deleted instead
// - orphaned objects are transferred to the fallback owner only for
//   requested types, otherwise undeployed and removed
// - the JupyterHub home volume is deleted
export function parseDeleteOptions (body) {
  const options = body && typeof body === 'object' ? body : {}

  if (options.collections !== undefined) {
    if (!Array.isArray(options.collections)) {
      throw new Error('collections must be an array of collection names')
    }
    for (const collection of options.collections) {
      if (typeof collection !== 'string' || !isKnownCollection(collection)) {
        throw new Error(`Unknown collection in scope: ${collection}`)
      }
    }
  }

  if (options.transferTo !== undefined && options.transferTo !== null) {
    if (typeof options.transferTo !== 'string' || !UUID_PATTERN.test(options.transferTo)) {
      throw new Error('transferTo must be a Directus user id')
    }
  }

  if (options.deleteJupyterVolume !== undefined && typeof options.deleteJupyterVolume !== 'boolean') {
    throw new Error('deleteJupyterVolume must be a boolean')
  }

  return {
    collections: options.collections ?? DEFAULT_COLLECTION_SCOPE,
    transferTo: options.transferTo ?? null,
    deleteJupyterVolume: options.deleteJupyterVolume ?? true
  }
}
