import k8s from '@kubernetes/client-node'
import { isNotFound } from './is-not-found.js'
import { JUPYTERHUB_NAMESPACE } from './config.js'

// In-cluster Kubernetes client (the Directus pod runs with a ServiceAccount
// that can manage the JupyterHub namespace resources). The singleton keeps
// the loaded config across requests.
let coreClient

function getCoreClient () {
  if (!coreClient) {
    const kc = new k8s.KubeConfig()
    kc.loadFromDefault()
    coreClient = kc.makeApiClient(k8s.CoreV1Api)
  }
  return coreClient
}

/**
 * Deletes a persistent volume claim by name in the JupyterHub namespace.
 * A missing claim (never created, already deleted) is treated as success
 * to keep the deletion sequence re-runnable; the return value tells the
 * caller whether the claim actually existed — with KubeSpawner's default
 * `delete_pvc = true` the hub itself removes the claim with the user, so
 * "already gone" is the expected case and not an error.
 */
export async function deletePersistentVolumeClaim (name, namespace = JUPYTERHUB_NAMESPACE) {
  try {
    await getCoreClient().deleteNamespacedPersistentVolumeClaim(
      name,
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      'Background'
    )
    return true
  } catch (err) {
    if (!isNotFound(err)) throw err
    return false
  }
}
