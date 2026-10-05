import { ConfigService } from '@nestjs/config';
import {
  buildRetentionPolicy,
  getArchivedRecordRetentionExpiresAt,
} from './retention-policy';

describe('archived record retention policy', () => {
  it('keeps autonomous archived deletion disabled while archive quotas are atomic', () => {
    const config = new ConfigService({
      ARCHIVED_RECORD_AUTO_DELETE_ENABLED: 'true',
      ARCHIVED_RECORD_RETENTION_DAYS: 30,
    });

    expect(buildRetentionPolicy(config).archivedRecordAutoDeleteEnabled).toBe(
      false,
    );
    expect(
      getArchivedRecordRetentionExpiresAt(
        new Date('2026-09-01T00:00:00.000Z'),
        config,
      ),
    ).toBeUndefined();
  });
});
