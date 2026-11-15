import { createHash } from 'node:crypto';
import type {
  RenewalNoticeCandidate,
  RenewalNoticeMessage,
} from './renewal-notice.types';

const dayMs = 86_400_000;
const mexicoDateParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Mexico_City',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});
const mexicoDateLabel = new Intl.DateTimeFormat('es-MX', {
  timeZone: 'America/Mexico_City',
  dateStyle: 'long',
});

export function mexicoDay(date: Date): number {
  const parts = mexicoDateParts.formatToParts(date);
  const number = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(number('year'), number('month') - 1, number('day')) / dayMs;
}

export function renewalNoticeDueDay(candidate: RenewalNoticeCandidate): number {
  return mexicoDay(new Date(candidate.renewalAt * 1000)) - 7;
}

export function noticeWindow(
  candidate: RenewalNoticeCandidate,
  now: Date,
): 'early' | 'due' | 'late' {
  const elapsed = mexicoDay(now) - renewalNoticeDueDay(candidate);
  if (elapsed < 0) return 'early';
  if (elapsed > 2) return 'late';
  return 'due';
}

export function renewalNoticeKey(candidate: RenewalNoticeCandidate): string {
  const period = Buffer.from(
    JSON.stringify([candidate.subscriptionId, candidate.renewalAt]),
  );
  return `renewal-${createHash('sha256').update(period).digest('hex')}`;
}

export function renewalNoticeMessage(
  candidate: RenewalNoticeCandidate,
  recipient: string,
  stage: 'dev' | 'prod' = 'dev',
): RenewalNoticeMessage {
  const date = mexicoDateLabel.format(new Date(candidate.renewalAt * 1000));
  const amount = new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: candidate.currency,
    currencyDisplay: 'code',
  }).format(candidate.amountMinor / 100);
  return {
    recipient,
    noticeId: renewalNoticeKey(candidate),
    subject:
      stage === 'prod'
        ? 'Aviso de renovación de Plus Hogar'
        : '[Prueba de DespensaLista] Aviso de renovación de Plus Hogar',
    text: [
      `La próxima renovación de tu plan Plus Hogar está programada para el ${date} (hora de Ciudad de México).`,
      `El precio mensual de tu plan es ${amount}.`,
      'Puedes revisar tu suscripción y cancelar la renovación sin penalización desde Perfil.',
      stage === 'prod'
        ? 'https://despensalista.com/profile'
        : 'https://dev.despensalista.lynxpardelle.com/profile',
      ...(stage === 'dev'
        ? [
            'Este mensaje es una prueba de DespensaLista. No se realizará un cobro real.',
          ]
        : []),
    ].join('\n\n'),
  };
}
