import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  HouseholdActivityType,
  HouseholdRole,
} from '../../../../domain/entities/household.entity';

export type HouseholdDocumentModel = HydratedDocument<HouseholdDocument>;

export type HouseholdEntityType =
  | 'HOUSEHOLD'
  | 'HOUSEHOLD_MEMBERSHIP'
  | 'HOUSEHOLD_INVITE'
  | 'HOUSEHOLD_ACTIVITY';

@Schema({
  collection: 'households',
  timestamps: false,
  versionKey: false,
})
export class HouseholdDocument {
  @Prop({ required: true, unique: true, index: true })
  pk: string;

  @Prop({ required: true, index: true })
  entityType: HouseholdEntityType;

  @Prop({ required: false, index: true })
  id?: string;

  @Prop({ required: false })
  name?: string;

  @Prop({ required: false, index: true })
  ownerUserId?: string;

  @Prop({ required: false })
  deleting?: string;

  @Prop({ required: false })
  mutationVersion?: number;

  @Prop({ required: false, index: true })
  householdId?: string;

  @Prop({ required: false, index: true })
  userId?: string;

  @Prop({ required: false })
  email?: string;

  @Prop({ required: false })
  username?: string;

  @Prop({ required: false, index: true })
  invitedEmail?: string;

  @Prop({ required: false, index: true })
  activityType?: HouseholdActivityType;

  @Prop({ required: false })
  type?: HouseholdActivityType;

  @Prop({ required: false, index: true })
  actorUserId?: string;

  @Prop({ required: false, index: true })
  targetUserId?: string;

  @Prop({ required: false })
  targetLabel?: string;

  @Prop({ required: false })
  invitedByUserId?: string;

  @Prop({ required: false, enum: ['owner', 'editor', 'viewer'] })
  role?: HouseholdRole;

  @Prop({ required: false, index: true })
  tokenHash?: string;

  @Prop({ required: false })
  joinedAt?: Date;

  @Prop({ required: false })
  expiresAt?: Date;

  @Prop({ required: false })
  acceptedAt?: Date;

  @Prop({ required: false })
  revokedAt?: Date;

  @Prop({ required: false })
  privacyRedacted?: boolean;

  @Prop({ required: true })
  createdAt: Date;

  @Prop({ required: true })
  updatedAt: Date;
}

export const HouseholdSchema = SchemaFactory.createForClass(HouseholdDocument);

HouseholdSchema.index({ entityType: 1, userId: 1 });
HouseholdSchema.index(
  { userId: 1 },
  {
    name: 'unique_household_membership_user',
    unique: true,
    partialFilterExpression: { entityType: 'HOUSEHOLD_MEMBERSHIP' },
  },
);
HouseholdSchema.index({ entityType: 1, householdId: 1 });
HouseholdSchema.index({ entityType: 1, householdId: 1, createdAt: -1 });
HouseholdSchema.index({ entityType: 1, tokenHash: 1 }, { sparse: true });
HouseholdSchema.index(
  { expiresAt: 1 },
  {
    name: 'household_invite_ttl',
    expireAfterSeconds: 0,
    partialFilterExpression: { entityType: 'HOUSEHOLD_INVITE' },
  },
);
