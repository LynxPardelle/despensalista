import { BadRequestException } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { cfdiCatalog } from './cfdi-catalog';

export interface CfdiFiscalData {
  rfc: string;
  legalName: string;
  postalCode: string;
  taxRegime: string;
  cfdiUse: string;
  accountEmail?: string;
  additionalEmail?: string;
}

const genericRfcs = new Set(['XAXX010101000', 'XEXX010101000']);
const allowedFields = new Set([
  'rfc',
  'legalName',
  'postalCode',
  'taxRegime',
  'cfdiUse',
  'additionalEmail',
  'email',
]);

function field(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function validContactAddress(email: string): boolean {
  return (
    email.length <= 254 &&
    /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+$/i.test(email) &&
    isEmail(email)
  );
}

export function readCfdiRequest(
  input: unknown,
  accountEmail: string | null = null,
): CfdiFiscalData {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('Revisa los datos fiscales de la solicitud.');
  }
  const request = input as Record<string, unknown>;
  const { additionalEmail: rawAdditionalEmail, email: rawLegacyEmail } =
    request;
  const rfc = field(request, 'rfc').normalize('NFC').toUpperCase();
  const legalName = field(request, 'legalName').normalize('NFC');
  const postalCode = field(request, 'postalCode');
  const taxRegime = field(request, 'taxRegime');
  const cfdiUse = field(request, 'cfdiUse').toUpperCase();
  const extra = field(request, 'additionalEmail');
  const legacy = field(request, 'email');
  if (
    Object.keys(request).some((key) => !allowedFields.has(key)) ||
    !/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc) ||
    legalName.length < 1 ||
    legalName.length > 254 ||
    !/^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u.test(legalName) ||
    !/^\d{5}$/.test(postalCode) ||
    !validTaxCodes(rfc, taxRegime, cfdiUse) ||
    (rawAdditionalEmail !== undefined &&
      typeof rawAdditionalEmail !== 'string') ||
    (rawLegacyEmail !== undefined && typeof rawLegacyEmail !== 'string') ||
    (extra !== '' && !validContactAddress(extra)) ||
    (legacy !== '' && !validContactAddress(legacy)) ||
    (extra && legacy && extra.toLowerCase() !== legacy.toLowerCase())
  ) {
    throw new BadRequestException('Revisa los datos fiscales de la solicitud.');
  }
  const additionalEmail = extra || legacy;
  return {
    rfc,
    legalName,
    postalCode,
    taxRegime,
    cfdiUse,
    ...(accountEmail && { accountEmail }),
    ...(additionalEmail &&
      additionalEmail.toLowerCase() !== accountEmail?.toLowerCase() && {
        additionalEmail,
      }),
  };
}

function validTaxCodes(
  rfc: string,
  taxRegime: string,
  cfdiUse: string,
): boolean {
  const regime = cfdiCatalog.regimes.find((entry) => entry.code === taxRegime);
  const use = cfdiCatalog.uses.find((entry) => entry.code === cfdiUse);
  if (!regime || !use || !use.regimes.some((code) => code === taxRegime)) {
    return false;
  }
  if (genericRfcs.has(rfc)) return taxRegime === '616' && cfdiUse === 'S01';
  return rfc.length === 13
    ? regime.individual && use.individual
    : regime.organization && use.organization;
}
