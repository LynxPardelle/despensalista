import { ExpirationStatus, QuantityUnit } from '../enums';
import { InventoryLot } from './inventory-lot.entity';

describe('InventoryLot expiration status', () => {
  const baseLot = {
    id: 'lot-1',
    userId: 'user-1',
    productTypeId: 'type-1',
    quantity: 1,
    unit: QuantityUnit.PIECE,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt: new Date('2026-04-01T00:00:00.000Z'),
  };

  it('marks lots before the current calendar day as expired', () => {
    const lot = InventoryLot.fromPrimitives({
      ...baseLot,
      expiresAt: new Date('2026-04-27T23:59:00.000Z'),
    });

    expect(lot.getExpirationStatus(new Date('2026-04-28T08:00:00.000Z'))).toBe(
      ExpirationStatus.EXPIRED,
    );
  });

  it('keeps today as critical and future dates inside the configured window as soon', () => {
    const todayLot = InventoryLot.fromPrimitives({
      ...baseLot,
      id: 'lot-today',
      expiresAt: new Date('2026-04-28T00:00:00.000Z'),
    });
    const soonLot = InventoryLot.fromPrimitives({
      ...baseLot,
      id: 'lot-soon',
      expiresAt: new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(
      todayLot.getExpirationStatus(new Date('2026-04-28T23:00:00.000Z'), 5),
    ).toBe(ExpirationStatus.CRITICAL);
    expect(
      soonLot.getExpirationStatus(new Date('2026-04-28T08:00:00.000Z'), 5),
    ).toBe(ExpirationStatus.SOON);
  });

  it('honors the configurable soon window when checking expiring lots', () => {
    const lot = InventoryLot.fromPrimitives({
      ...baseLot,
      expiresAt: new Date('2026-05-03T00:00:00.000Z'),
    });
    const referenceDate = new Date('2026-04-28T08:00:00.000Z');

    expect(lot.isExpiringWithinDays(3, referenceDate)).toBe(false);
    expect(lot.isExpiringWithinDays(5, referenceDate)).toBe(true);
  });

  it('uses the Mexico City day when UTC crosses midnight at 18:00', () => {
    const todayLot = InventoryLot.fromPrimitives({
      ...baseLot,
      expiresAt: new Date('2026-04-28T00:00:00.000Z'),
    });
    const tomorrowLot = InventoryLot.fromPrimitives({
      ...baseLot,
      id: 'lot-tomorrow',
      expiresAt: new Date('2026-04-29T00:00:00.000Z'),
    });
    const dayAfterLot = InventoryLot.fromPrimitives({
      ...baseLot,
      id: 'lot-day-after',
      expiresAt: new Date('2026-04-30T00:00:00.000Z'),
    });
    const eveningInMexico = new Date('2026-04-29T00:00:00.000Z');

    expect(todayLot.getExpirationStatus(eveningInMexico, 1)).toBe(
      ExpirationStatus.CRITICAL,
    );
    expect(tomorrowLot.getExpirationStatus(eveningInMexico, 1)).toBe(
      ExpirationStatus.SOON,
    );
    expect(dayAfterLot.getExpirationStatus(eveningInMexico, 1)).toBe(
      ExpirationStatus.STABLE,
    );
    expect(dayAfterLot.isExpiringWithinDays(1, eveningInMexico)).toBe(false);
    expect(
      todayLot.getExpirationStatus(new Date('2026-04-29T06:00:00.000Z')),
    ).toBe(ExpirationStatus.EXPIRED);
  });

  it('archives and restores inventory lots without changing quantity', () => {
    const lot = InventoryLot.fromPrimitives(baseLot);

    lot.archive('Regalado');

    expect(lot.isArchived()).toBe(true);
    expect(lot.toPrimitives()).toMatchObject({
      quantity: 1,
      archivedReason: 'Regalado',
    });

    lot.restore();

    expect(lot.isArchived()).toBe(false);
    expect(lot.toPrimitives().archivedAt).toBeUndefined();
    expect(lot.toPrimitives().archivedReason).toBeUndefined();
  });
});
