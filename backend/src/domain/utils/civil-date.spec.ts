import {
  addCivilMonths,
  mexicoCityDateLabel,
  utcDateLabel,
} from './civil-date';

describe('civil date labels', () => {
  it('preserves four-digit years below 0100 without remapping them to 19xx', () => {
    expect(utcDateLabel(new Date('0099-04-28T23:59:00.000Z'))).toEqual(
      new Date('0099-04-28T00:00:00.000Z'),
    );
    expect(mexicoCityDateLabel(new Date('0099-04-28T12:00:00.000Z'))).toEqual(
      new Date('0099-04-28T00:00:00.000Z'),
    );
    expect(addCivilMonths(new Date('0099-01-31T00:00:00.000Z'), 1)).toEqual(
      new Date('0099-02-28T00:00:00.000Z'),
    );
    expect(addCivilMonths(new Date('0099-12-31T00:00:00.000Z'), 1)).toEqual(
      new Date('0100-01-31T00:00:00.000Z'),
    );
  });
});
