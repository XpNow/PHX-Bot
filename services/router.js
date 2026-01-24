export function parseCustomId(customId){
  const parts = customId.split(':');
  return { ns: parts[0], action: parts[1] || '', args: parts.slice(2) };
}
