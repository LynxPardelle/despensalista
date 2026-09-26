import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { UserAccountStatus } from '../../../../domain/enums';
import { UserPreferencesPrimitives } from '../../../../domain/value-objects/user-preferences.vo';

export type UserDocumentModel = HydratedDocument<UserDocument>;

@Schema({
  collection: 'users',
  timestamps: false,
  versionKey: false,
})
export class UserDocument {
  @Prop({ required: true, unique: true, index: true })
  id: string;

  @Prop({ required: true, unique: true })
  email: string;

  @Prop({ required: true })
  normalizedEmail: string;

  @Prop({ required: true, unique: true })
  username: string;

  @Prop({ required: true })
  normalizedUsername: string;

  @Prop({ required: true, default: [] })
  authSubjectIds: string[];

  @Prop({ required: true, enum: Object.values(UserAccountStatus), index: true })
  status: UserAccountStatus;

  @Prop({ required: false })
  deletionFenceExpiresAt?: Date;

  @Prop({ required: false, type: Object })
  preferences?: Partial<UserPreferencesPrimitives>;

  @Prop({ required: true })
  createdAt: Date;

  @Prop({ required: true })
  updatedAt: Date;
}

export const UserSchema = SchemaFactory.createForClass(UserDocument);

UserSchema.index({ normalizedEmail: 1 }, { unique: true });
UserSchema.index({ normalizedUsername: 1 }, { unique: true });
UserSchema.index({ authSubjectIds: 1 }, { unique: true, sparse: true });
