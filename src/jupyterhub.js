import axios from 'axios'
import { isNotFound } from './is-not-found.js'
import { deletePersistentVolumeClaim } from './kubernetes.js'
import { JUPYTERHUB_API_TOKEN, JUPYTERHUB_API_URL } from './config.js'

// Hub API client — the base URL points at the JupyterHub REST API
// (e.g. https://jupyter.example.com/hub/api) and the token is a JupyterHub
// admin API token
// JupyterHub's REST API always lives at <hub>/hub/api — accept base URLs
// with or without that suffix so a misconfigured URL doesn't silently hit
// the hub's web routes (which answer browser requests with XSRF errors)
function hubApiBaseUrl (url) {
  const trimmed = (url || '').replace(/\/+$/, '')
  if (!trimmed || trimmed.endsWith('/api')) return trimmed
  if (trimmed.endsWith('/hub')) return `${trimmed}/api`
  return `${trimmed}/hub/api`
}

const hubClient = axios.create({
  baseURL: hubApiBaseUrl(JUPYTERHUB_API_URL),
  headers: { Authorization: `token ${JUPYTERHUB_API_TOKEN}` },
  timeout: 15000
})

// Axios error messages only say "Request failed with status code N" — append
// the hub's own response message so the step report says WHY a request was
// rejected (invalid token, missing scope, …) instead of a bare status code.
// The original error object is kept intact so isNotFound() still works.
hubClient.interceptors.response.use(null, err => {
  const status = err.response?.status
  const data = err.response?.data
  // API errors carry a message field; a full HTML document means the
  // request hit a non-API route — summarize instead of dumping the page
  const detail = data?.message
    ? data.message
    : (typeof data === 'string' && data.trim().startsWith('<'))
        ? '<HTML error page — not an API response>'
        : (typeof data === 'string' ? data.trim() : '')
  if (status) {
    err.message = `JupyterHub API returned ${status}${detail ? `: ${detail}` : ''}`
  }
  return Promise.reject(err)
})

// The JupyterHub home volume of a user is a PVC named claim-<username> in
// the JupyterHub namespace (pvcNameTemplate "claim-{username}{servername}";
// the default server has no name suffix)
export function jupyterVolumeName (username) {
  return `claim-${username}`
}

/**
 * Deletes a JupyterHub user and their resources via the Hub API.
 *
 * The Hub API refuses to delete a user whose server is still running, and
 * stopping a server is asynchronous — so the sequence is stop, wait until
 * the server is gone, then delete the user. Every step tolerates "already
 * gone" (404) so the whole operation is re-runnable after a partial
 * failure.
 *
 * Returns a step report for the deletion response.
 */
export async function deleteJupyterUser ({ username, deleteVolume }) {
  const report = {
    username,
    serverStopped: false,
    userDeleted: false,
    volumeDeleted: false
  }

  try {
    await deleteJupyterUserSteps({ username, deleteVolume, report })
    return report
  } catch (err) {
    // Carry the partial progress (serverStopped/userDeleted/volumeDeleted)
    // on the error so the deletion report shows what already succeeded
    // instead of only the error
    err.jupyterhubReport = report
    throw err
  }
}

async function deleteJupyterUserSteps ({ username, deleteVolume, report }) {
  // Probe the user first. On re-runs after a partial failure the account
  // is often already gone — and this hub version answers a server-stop
  // request for a missing user with a 500 (AttributeError in the delete
  // handler) instead of a 404, so probing keeps re-runs off that path
  // entirely.
  let userGone = false
  try {
    await hubClient.get(`/users/${encodeURIComponent(username)}`)
  } catch (err) {
    if (!isNotFound(err)) throw err
    userGone = true
  }

  if (userGone) {
    // Nothing left to stop or delete — only the volume safety net remains
    return
  }

  // 1. Stop the running server (no-op with 404 when not running)
  await hubClient.delete(`/users/${encodeURIComponent(username)}/server`)
  report.serverStopped = true

  // 2. Wait for the server to actually stop before deleting the user
  await waitForServerShutdown(username)

  // 3. Delete the hub user (404 = already deleted, fine on re-runs)
  try {
    await hubClient.delete(`/users/${encodeURIComponent(username)}`)
    report.userDeleted = true
  } catch (err) {
    if (!isNotFound(err)) throw err
    report.userDeleted = true
  }

  // 4. Delete the home volume when requested. This is a safety net: with
  // KubeSpawner's default `delete_pvc = true` (not overridden in the
  // kitegg deployment), the hub itself deletes the claim together with
  // the user — the step then just confirms it is gone
  if (deleteVolume) {
    const existed = await deletePersistentVolumeClaim(jupyterVolumeName(username))
    report.volumeDeleted = existed
    report.volumeAlreadyGone = !existed
  }
}

// Stopping a server is asynchronous: poll the user until the server entry
// disappears. Bounded so a stuck hub fails the step instead of hanging the
// deletion request.
const SHUTDOWN_TIMEOUT_MS = 30000
const SHUTDOWN_POLL_INTERVAL_MS = 1000

async function waitForServerShutdown (username) {
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const { data } = await hubClient.get(`/users/${encodeURIComponent(username)}`)
      if (!data?.server) return
    } catch (err) {
      if (isNotFound(err)) return
      throw err
    }
    await new Promise(resolve => setTimeout(resolve, SHUTDOWN_POLL_INTERVAL_MS))
  }
  throw new Error(`JupyterHub server of ${username} did not stop within ${SHUTDOWN_TIMEOUT_MS / 1000}s`)
}
