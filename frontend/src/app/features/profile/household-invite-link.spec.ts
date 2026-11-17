import { readHouseholdInviteCode } from './household-invite-link';

describe('readHouseholdInviteCode', () => {
  const code = 'invite-token-safe-123';
  const production = 'https://despensalista.com';
  const development = 'https://dev.despensalista.lynxpardelle.com';
  const testing = 'https://test.despensalista.lynxpardelle.com';
  const invitePath = `/profile?householdInvite=${code}`;

  it('trims a standalone code', () => {
    expect(readHouseholdInviteCode(` ${code}\n`)).toBe(code);
  });

  it('allows the canonical domain and both production aliases only from production', () => {
    const legacy = 'https://despensalista.lynxpardelle.com';
    expect(readHouseholdInviteCode(`${legacy}${invitePath}`, production)).toBe(code);
    expect(readHouseholdInviteCode(`${production}${invitePath}`, legacy)).toBe(code);
    expect(readHouseholdInviteCode(`https://www.despensalista.com${invitePath}`, production)).toBe(code);
    expect(readHouseholdInviteCode(`${legacy}${invitePath}`, testing)).toBeNull();
  });

  it('rejects other stages, wrong paths, embedded credentials and ambiguous codes', () => {
    expect(readHouseholdInviteCode(`${development}${invitePath}`, development)).toBe(code);
    expect(readHouseholdInviteCode(`${development}${invitePath}`, testing)).toBeNull();
    expect(readHouseholdInviteCode(`${testing}/pantry?householdInvite=${code}`, testing)).toBeNull();
    expect(readHouseholdInviteCode(`https://user@despensalista.com${invitePath}`, production)).toBeNull();
    expect(readHouseholdInviteCode(`${production}${invitePath}&householdInvite=${code}`, production)).toBeNull();
  });
});
