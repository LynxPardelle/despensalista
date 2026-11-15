import {
  HouseholdActivityPrimitives,
  HouseholdInvitePrimitives,
  HouseholdMembershipPrimitives,
  HouseholdPrimitives,
} from '../../domain/entities/household.entity';
import { HouseholdPlan } from '../ports/household-plan-reader';

export interface HouseholdWorkspace {
  household: HouseholdPrimitives;
  plan: HouseholdPlan;
  currentMember: HouseholdMembershipPrimitives;
  members: HouseholdMembershipPrimitives[];
  invites: HouseholdInvitePrimitives[];
  activities: HouseholdActivityPrimitives[];
}
