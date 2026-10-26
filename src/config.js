// Optional integrations for the user deletion sequence. All three deletion
// steps (JupyterHub → Directus → Keycloak) are required for a complete
// deletion — a missing JupyterHub configuration fails the step loudly
// instead of silently leaving orphaned hub users behind.

export const JUPYTERHUB_API_URL = (process.env.JUPYTERHUB_API_URL || '').replace(/\/+$/, '')
export const JUPYTERHUB_API_TOKEN = process.env.JUPYTERHUB_API_TOKEN || ''
// Kubernetes namespace holding the JupyterHub user home volumes
// (PVCs named claim-<username>)
export const JUPYTERHUB_NAMESPACE = process.env.JUPYTERHUB_NAMESPACE || 'jupyterhub'

export function isJupyterHubConfigured () {
  return !!(JUPYTERHUB_API_URL && JUPYTERHUB_API_TOKEN)
}
