import { BadRequestException } from '@nestjs/common';
import { readCfdiRequest } from './cfdi-request';

const individual = {
  rfc: 'ABCD010101AA1',
  legalName: 'Persona de prueba',
  postalCode: '01234',
  taxRegime: '605',
  cfdiUse: 'D01',
};

it('accepts compatible regimes and usages for individuals and organizations', () => {
  expect(readCfdiRequest(individual)).toEqual(individual);
  const organization = {
    ...individual,
    rfc: 'ABC010101AA1',
    taxRegime: '601',
    cfdiUse: 'G03',
  };
  expect(readCfdiRequest(organization)).toEqual(organization);
});

it.each([
  { rfc: 'ABC010101AA1' },
  { taxRegime: '601' },
  { taxRegime: '699' },
  { cfdiUse: 'G03' },
  { cfdiUse: 'Z99' },
  { rfc: 'XEXX010101000' },
  { rfc: 'XAXX010101000', taxRegime: '616', cfdiUse: 'G03' },
])('rejects catalog codes that are incompatible or unknown (%j)', (change) => {
  expect(() => readCfdiRequest({ ...individual, ...change })).toThrow(
    BadRequestException,
  );
});

it.each(['XAXX010101000', 'XEXX010101000'])(
  'accepts 616 and S01 for generic RFC %s',
  (rfc) => {
    const generic = { ...individual, rfc, taxRegime: '616', cfdiUse: 'S01' };
    expect(readCfdiRequest(generic)).toEqual(generic);
  },
);

it('normalizes the legacy email alias to an optional additional address', () => {
  expect(
    readCfdiRequest({ ...individual, email: ' extra@example.com ' }),
  ).toEqual({
    ...individual,
    additionalEmail: 'extra@example.com',
  });
  expect(() =>
    readCfdiRequest({
      ...individual,
      email: 'old@example.com',
      additionalEmail: 'new@example.com',
    }),
  ).toThrow(BadRequestException);
});

it('rejects forged primary emails in the request body', () => {
  expect(() =>
    readCfdiRequest({ ...individual, accountEmail: 'someone@example.com' }),
  ).toThrow(BadRequestException);
});

it('omits additional addresses that duplicate the account email', () => {
  const accountEmail = 'owner@example.com';
  expect(
    readCfdiRequest(
      { ...individual, additionalEmail: ' OWNER@EXAMPLE.COM ' },
      accountEmail,
    ),
  ).toEqual({
    ...individual,
    accountEmail,
  });
  expect(
    readCfdiRequest(
      { ...individual, additionalEmail: 'extra@example.com' },
      accountEmail,
    ),
  ).toEqual({
    ...individual,
    accountEmail,
    additionalEmail: 'extra@example.com',
  });
});
