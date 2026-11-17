const inviteCodePattern = /^[a-zA-Z0-9_-]{16,256}$/;
const productionOrigins = new Set([
  'https://despensalista.com',
  'https://www.despensalista.com',
  'https://despensalista.lynxpardelle.com',
]);

export function readHouseholdInviteCode(value: string, currentOrigin?: string): string | null {
  const input = value.trim();
  if (inviteCodePattern.test(input)) return input;
  if (!currentOrigin) return null;

  let link: URL;
  try {
    link = new URL(input);
  } catch {
    return null;
  }

  const sameEnvironment = link.origin === currentOrigin ||
    (productionOrigins.has(currentOrigin) && productionOrigins.has(link.origin));
  if (!sameEnvironment || (link.protocol !== 'https:' && link.protocol !== 'http:') ||
      link.username || link.password || !['/profile', '/profile/'].includes(link.pathname)) {
    return null;
  }

  const codes = link.searchParams.getAll('householdInvite');
  return codes.length === 1 && inviteCodePattern.test(codes[0]) ? codes[0] : null;
}
