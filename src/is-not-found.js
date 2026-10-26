// Axios errors expose the backend status on err.response.status — a 404
// means the resource is already gone, which every deletion step treats as
// success so the whole sequence can be re-run after a partial failure
export function isNotFound (err) {
  return err?.response?.status === 404 || err?.statusCode === 404
}
