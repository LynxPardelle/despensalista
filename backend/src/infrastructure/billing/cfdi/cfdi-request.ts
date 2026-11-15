import { BadRequestException } from '@nestjs/common';
import { isEmail } from 'class-validator';

export interface CfdiFiscalData {
  rfc: string;
  legalName: string;
  postalCode: string;
  taxRegime: string;
  cfdiUse: string;
  email?: string;
}

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

export function readCfdiRequest(input: unknown): CfdiFiscalData {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('Revisa los datos fiscales de la solicitud.');
  }
  const request = input as Record<string, unknown>;
  const { email: rawEmail } = request;
  const rfc = field(request, 'rfc').normalize('NFC').toUpperCase();
  const legalName = field(request, 'legalName').normalize('NFC');
  const postalCode = field(request, 'postalCode');
  const taxRegime = field(request, 'taxRegime');
  const cfdiUse = field(request, 'cfdiUse').toUpperCase();
  const email = field(request, 'email');
  if (
    Object.keys(request).some(
      (key) =>
        ![
          'rfc',
          'legalName',
          'postalCode',
          'taxRegime',
          'cfdiUse',
          'email',
        ].includes(key),
    ) ||
    !/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc) ||
    legalName.length < 1 ||
    legalName.length > 254 ||
    !/^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u.test(legalName) ||
    !/^\d{5}$/.test(postalCode) ||
    !/^6\d{2}$/.test(taxRegime) ||
    !/^[A-Z]{1,2}\d{2}$/.test(cfdiUse) ||
    (rawEmail !== undefined && typeof rawEmail !== 'string') ||
    (email !== '' && !validContactAddress(email))
  ) {
    throw new BadRequestException('Revisa los datos fiscales de la solicitud.');
  }
  return {
    rfc,
    legalName,
    postalCode,
    taxRegime,
    cfdiUse,
    ...(email && { email }),
  };
}
