/** One selected host directory; no execution, credentials or binding fields from a phone. */
const fault = (message, status = 400) => Object.assign(new Error(message), { status });
export function hostFolderUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'hostFolder')
    || typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt || body.expectedUpdatedAt.length > 60) throw fault('Refresh this bot before changing its folder access.');
  if (body.hostFolder === null) return { expectedUpdatedAt: body.expectedUpdatedAt, hostFolder: null };
  const folder = body.hostFolder;
  if (!folder || typeof folder !== 'object' || Array.isArray(folder) || Object.keys(folder).length !== 2
    || typeof folder.path !== 'string' || !folder.path.startsWith('/') || folder.path.length > 4_000 || /[\u0000-\u001f\u007f]/.test(folder.path)
    || !['read', 'read-write'].includes(folder.access)) throw fault('Choose a full host folder path and read or read/write access.');
  return { expectedUpdatedAt: body.expectedUpdatedAt, hostFolder: { path: folder.path, access: folder.access } };
}
export function hostFolderRequest(path, method, body) {
  if (!/^\/api\/bots\/[a-zA-Z0-9_-]{1,120}\/host-folder$/.test(path)) return false;
  if (method !== 'PUT') throw fault('This folder action is unavailable.', 405);
  hostFolderUpdate(body); return true;
}
