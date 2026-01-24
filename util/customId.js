export function encodeCustomId(payload) {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  return b64.slice(0, 100);
}

export function decodeCustomId(customId) {
  try {
    const json = Buffer.from(customId, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}
