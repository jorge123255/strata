// Public bot profile drafts only. Saved model/computer IDs are resolved by the
// owning host, never expanded into credentials or SSH settings on the phone.
const fail = (status, message) => Object.assign(new Error(message), { status });
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const providers = ['claude', 'codex', 'grok', 'kimi', 'ollama', 'configured'];
const avatars = ['🤖', '🧑‍💻', '🦊', '🧠', '🚀', '🛠️', '🌿', '✨'];
export const BOT_AVATAR_SHAPES = Object.freeze(['orb', 'pebble', 'tile', 'diamond', 'spark', 'hexagon']);
// Optional shapes leave the original kind/color vocabulary readable by older
// phones. Their koala fallback ignores the new field without losing the catalog.
export function botAvatarConfig(value, status = 400) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['kind', 'color', 'eyes', 'ears', 'shape'].includes(key))
    || !['cloud', 'violet', 'orange', 'sky', 'graphite', 'slate'].includes(value.color) || !['star', 'round', 'happy', 'calm', 'plus', 'delight'].includes(value.eyes) || !['scalloped', 'round', 'small'].includes(value.ears)
    || Object.hasOwn(value, 'kind') && !['koala', 'fox', 'cat', 'robot'].includes(value.kind)
    || Object.hasOwn(value, 'shape') && ![...BOT_AVATAR_SHAPES, 'classic'].includes(value.shape)
    || BOT_AVATAR_SHAPES.includes(value.shape) && value.kind !== undefined && value.kind !== 'koala') throw fail(status, 'Choose a supported bot character, color, eyes and ears.');
  return { color: value.color, eyes: value.eyes, ears: value.ears, ...(value.kind ? { kind: value.kind } : {}), ...(value.shape ? { shape: value.shape } : {}) };
}
export function botProfileDraft(body, edit = false, status = 400) {
  const keys = ['name', 'provider', 'model', 'modelId', 'computerId', 'workspace', 'instructions', 'capabilities', 'policy', 'computerMode', 'effort', 'avatar', 'avatarConfig', ...(edit ? ['expectedUpdatedAt'] : [])];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw fail(status, 'Choose only the displayed bot settings.');
  if (!edit && (!Object.hasOwn(body, 'name') || !providers.includes(body.provider) || !id(body.computerId))) throw fail(status, 'Choose a name, provider and saved execution computer.');
  if (edit && (typeof body.expectedUpdatedAt !== 'string' || body.expectedUpdatedAt.length > 60 || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(body.expectedUpdatedAt))) throw fail(status, 'Refresh this bot before saving its settings.');
  for (const [key, max] of [['name',80], ['model',250], ['workspace',4000], ['instructions',32000], ['effort',32]]) if (Object.hasOwn(body,key)) {
    if (typeof body[key] !== 'string' || body[key].length > max || body[key].includes('\0') || key === 'name' && !body[key].trim()) throw fail(status, 'Enter supported bot settings.');
  }
  if (body.workspace !== undefined && (!body.workspace.startsWith('/') || /[\u0000-\u001f]/.test(body.workspace))) throw fail(status, 'Enter the full workspace folder path on the selected computer.');
  if (body.effort !== undefined && body.effort !== '' && !/^[a-z][a-z0-9_-]{0,31}$/.test(body.effort)) throw fail(status, 'Choose a supported effort.');
  for (const key of ['modelId', 'computerId']) if (Object.hasOwn(body,key) && !id(body[key])) throw fail(status, 'Choose saved items from the current list.');
  for (const [key, values] of [['provider',providers],['capabilities',['code','computer','both']],['policy',['manual','plan','bypass']],['computerMode',['host','cua']],['avatar',avatars]]) if (Object.hasOwn(body,key) && !values.includes(body[key])) throw fail(status, 'Choose a supported bot option.');
  if (body.avatarConfig !== undefined) {
    botAvatarConfig(body.avatarConfig, status);
  }
  if (body.provider && body.provider !== 'configured' && body.modelId !== undefined) throw fail(status, 'Choose configured models with Configured Models.');
  if (!edit && body.provider === 'configured' && !id(body.modelId)) throw fail(status, 'Choose a saved configured model.');
  if (body.computerMode === 'cua' && body.workspace !== undefined && body.workspace !== '/workspace') throw fail(status, 'The isolated computer uses /workspace.');
  return body;
}
export function botProfileRoute(path, method, body, status = 403) {
  const create = path === '/api/bots/profile';
  const edit = /^\/api\/bots\/[A-Za-z0-9_-]{1,120}\/profile$/.test(path);
  if (!create && !edit) return null;
  if (method !== (create ? 'POST' : 'PATCH')) throw fail(status, 'This bot profile action is unavailable.');
  botProfileDraft(body, edit, status);
  return { edit };
}
