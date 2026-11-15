import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isRenewalRecipient,
  renewalNoticeConfig,
  sesSuccessSimulator,
  type RenewalNoticeSettings,
} from './renewal-notice.config';
import {
  mexicoDay,
  noticeWindow,
  renewalNoticeMessage,
} from './renewal-notice.policy';
import {
  RenewalNoticeStore,
  type RenewalNoticeRow,
} from './renewal-notice.store';
import {
  RENEWAL_NOTICE_RECIPIENT,
  RENEWAL_NOTICE_TRANSPORT,
  type RenewalNoticeRecipient,
  type RenewalNoticeTransport,
  type RenewalRecipientResolution,
} from './renewal-notice.types';

const noticeIdPattern = /^renewal-[a-f0-9]{64}$/;
const dryRunConcurrency = 4;
// Reserve the remainder of the 15-second invocation for any work in progress.
const scheduledWorkAdmissionMs = 3_000;
// Leave six seconds for a production claim, bounded SES request, and completion.
const productionClaimAdmissionMs = 9_000;
const blankCounts = {
  wouldSend: 0,
  accepted: 0,
  skipped: 0,
  unknown: 0,
  late: 0,
  blocked: 0,
  deferred: 0,
  early: 0,
  busy: 0,
};
type DispatchOutcome = keyof typeof blankCounts;

@Injectable()
export class RenewalNoticeDispatcher {
  constructor(
    private readonly config: ConfigService,
    private readonly store: RenewalNoticeStore,
    @Inject(RENEWAL_NOTICE_RECIPIENT)
    private readonly recipient: RenewalNoticeRecipient,
    @Inject(RENEWAL_NOTICE_TRANSPORT)
    private readonly transport: RenewalNoticeTransport,
  ) {}

  async dispatch(now?: Date, onlyNoticeId?: string) {
    const settings = renewalNoticeConfig(this.config);
    const counts = { ...blankCounts };
    if (!settings)
      return { enabled: false, processed: 0, hasMoreDue: false, ...counts };

    const today = now ?? new Date();
    if (
      !Number.isFinite(today.getTime()) ||
      (settings.stage === 'prod' &&
        (now !== undefined || onlyNoticeId !== undefined)) ||
      (onlyNoticeId !== undefined && !noticeIdPattern.test(onlyNoticeId))
    ) {
      throw new BadRequestException('Invalid renewal notice target');
    }
    if (onlyNoticeId) {
      const job = await this.store.read(settings.table, onlyNoticeId);
      const outcome = job ? await this.process(settings, job, now) : undefined;
      if (outcome) counts[outcome]++;
      return {
        enabled: true,
        processed: Number(outcome !== undefined),
        hasMoreDue: false,
        ...counts,
      };
    }

    const productionSending =
      settings.stage === 'prod' && settings.mode === 'ses';
    const admissionDeadline =
      performance.now() +
      (productionSending
        ? productionClaimAdmissionMs
        : scheduledWorkAdmissionMs);
    const { jobs, hasMoreDue } = await this.store.due(
      settings.table,
      mexicoDay(today),
    );
    // Keep the queue intact if the account is sandboxed, paused, or at quota.
    const allowance =
      productionSending && jobs.length && performance.now() < admissionDeadline
        ? await this.transport.assertProductionAccess()
        : undefined;
    if (allowance?.maxSends === 0) {
      throw new Error('SES production daily sending quota exhausted');
    }
    const concurrency = settings.mode === 'dry-run' ? dryRunConcurrency : 1;
    let processed = 0;
    while (
      processed < jobs.length &&
      performance.now() < admissionDeadline &&
      (!allowance || counts.accepted < allowance.maxSends)
    ) {
      const outcomes = await Promise.all(
        jobs
          .slice(processed, processed + concurrency)
          .map((job) =>
            this.process(
              settings,
              job,
              now,
              productionSending ? admissionDeadline : undefined,
            ),
          ),
      );
      for (const outcome of outcomes) {
        if (!outcome) break;
        counts[outcome]++;
        processed++;
      }
      if (
        outcomes.includes(undefined) ||
        (settings.mode === 'ses' &&
          (counts.unknown || (settings.stage === 'dev' && counts.accepted)))
      )
        break;
      if (
        allowance &&
        outcomes.includes('accepted') &&
        processed < jobs.length &&
        counts.accepted < allowance.maxSends
      ) {
        if (performance.now() + allowance.intervalMs >= admissionDeadline)
          break;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, allowance.intervalMs),
        );
      }
    }
    if (
      settings.stage === 'prod' &&
      settings.mode === 'ses' &&
      (counts.late || counts.blocked || counts.unknown)
    ) {
      // The existing Lambda Errors alarm reports terminal cases. All writes
      // already committed, so a retry cannot redeliver an uncertain message.
      throw new Error(
        `Renewal notices need attention (late=${counts.late}, blocked=${counts.blocked}, unknown=${counts.unknown})`,
      );
    }
    return {
      enabled: true,
      processed,
      hasMoreDue: hasMoreDue || processed < jobs.length,
      ...counts,
    };
  }

  private async process(
    settings: RenewalNoticeSettings,
    job: RenewalNoticeRow,
    calendarOverride?: Date,
    claimDeadline?: number,
  ): Promise<DispatchOutcome | undefined> {
    const calendarNow = () => calendarOverride ?? new Date();
    const wallSeconds = () => Math.floor(Date.now() / 1000);
    const budgetExhausted = () =>
      claimDeadline !== undefined && performance.now() >= claimDeadline;
    const finish = async (
      outcome: 'skipped' | 'late' | 'blocked' | 'unknown',
      reason: string,
    ): Promise<DispatchOutcome> => {
      if (settings.mode === 'dry-run') return outcome;
      return (await this.store.finish(
        settings.table,
        job,
        { state: outcome, reason },
        wallSeconds(),
      ))
        ? outcome
        : 'busy';
    };

    if (job.state === 'sending') {
      // The process could have stopped after the provider accepted the request.
      // An expired claim records uncertainty and must never be sent again.
      return job.claimExpiresAt <= wallSeconds()
        ? finish('unknown', 'interrupted_attempt')
        : 'busy';
    }
    const currentDay = mexicoDay(calendarNow());
    if (job.nextDay > currentDay) return 'early';
    const initialWindow = noticeWindow(job, calendarNow());
    if (initialWindow === 'early') return 'early';
    if (initialWindow === 'late' && settings.stage === 'dev')
      return finish('late', 'notice_window_elapsed');

    let resolution: RenewalRecipientResolution;
    try {
      resolution = await this.recipient.resolve(job);
    } catch {
      // No send has been attempted. A later run can still retry the lookup.
      if (budgetExhausted()) return undefined;
      if (settings.mode === 'dry-run') return 'deferred';
      return (await this.store.reschedule(
        settings.table,
        job,
        mexicoDay(calendarNow()) + 1,
      ))
        ? 'deferred'
        : 'busy';
    }
    if (budgetExhausted()) return undefined;
    if (resolution.status === 'skip') {
      return resolution.reason === 'missing_verified_recipient'
        ? finish('blocked', resolution.reason)
        : finish('skipped', resolution.reason);
    }
    if (noticeWindow(job, calendarNow()) === 'late') {
      return finish('late', 'notice_window_elapsed');
    }
    const verifiedAddress = resolution.recipient.trim().toLowerCase();
    if (
      settings.stage === 'prod' &&
      (!isRenewalRecipient(verifiedAddress) ||
        verifiedAddress.endsWith('@simulator.amazonses.com'))
    ) {
      return finish('blocked', 'invalid_production_recipient');
    }
    if (settings.mode === 'dry-run') return 'wouldSend';

    if (
      settings.stage === 'dev' &&
      settings.testRecipient !== sesSuccessSimulator &&
      settings.testRecipient !== verifiedAddress
    ) {
      return finish('blocked', 'recipient_outside_dev_allowlist');
    }
    const message = renewalNoticeMessage(
      job,
      settings.stage === 'prod' ? verifiedAddress : settings.testRecipient,
      settings.stage,
    );
    if (budgetExhausted()) return undefined;
    const claimed = await this.store.claim(settings.table, job, wallSeconds());
    if (!claimed) return 'busy';

    let messageId: string;
    try {
      const response = await this.transport.send(message);
      if (!response.messageId) throw new Error('Missing message ID');
      messageId = response.messageId;
    } catch {
      // A timeout or a missing response ID is not proof that no mail was sent.
      await this.store.finish(
        settings.table,
        claimed,
        { state: 'unknown', reason: 'provider_outcome_unknown' },
        wallSeconds(),
      );
      return 'unknown';
    }
    const accepted = await this.store.finish(
      settings.table,
      claimed,
      { state: 'accepted', messageId },
      wallSeconds(),
    );
    return accepted ? 'accepted' : 'unknown';
  }
}
