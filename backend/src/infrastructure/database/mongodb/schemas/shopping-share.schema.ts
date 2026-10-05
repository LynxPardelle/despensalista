import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ShoppingShareDocumentModel =
  HydratedDocument<ShoppingShareDocument>;

@Schema({
  collection: 'shoppingShares',
  timestamps: false,
  versionKey: false,
})
export class ShoppingShareDocument {
  @Prop({ required: true, unique: true, index: true })
  id: string;

  @Prop({ required: true, index: true })
  ownerUserId: string;

  @Prop({ required: true, unique: true, index: true })
  tokenHash: string;

  @Prop({ required: true })
  text: string;

  @Prop({ required: true })
  createdAt: Date;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ required: false })
  revokedAt?: Date;

  @Prop({ required: true })
  updatedAt: Date;
}

export const ShoppingShareSchema = SchemaFactory.createForClass(
  ShoppingShareDocument,
);

ShoppingShareSchema.index({ ownerUserId: 1, createdAt: -1 });
ShoppingShareSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'shopping_share_ttl' },
);
