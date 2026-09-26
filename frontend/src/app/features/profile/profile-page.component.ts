import { getUserErrorMessage } from '../../shared/user-error';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnInit,
  PLATFORM_ID,
  inject,
} from '@angular/core';
import { CommonModule, DOCUMENT, isPlatformBrowser } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { finalize } from 'rxjs/operators';
import { AuthFacade } from '../../core/services/auth.facade';
import { PantryService } from '../../core/services/pantry.service';
import { ProfileService } from '../../core/services/profile.service';
import {
  HouseholdActivity,
  HouseholdInvite,
  HouseholdRole,
  HouseholdWorkspace,
  UserProfile,
} from '../../shared/models/profile.model';

type MonetizationPlanId = 'free' | 'plus-household' | 'ai-capture-credits';

interface MonetizationPlan {
  id: MonetizationPlanId;
  name: string;
  priceLabel: string;
  statusLabel: string;
  features: string[];
  boundaries: string[];
}

interface MonetizationDiscoveryEvent {
  id: string;
  planId: MonetizationPlanId;
  provider: 'stripe';
  eventType: 'checkout_interest';
  createdAt: string;
}

interface PendingPantryDeletionIdempotencyKey {
  ownerUserId: string;
  key: string;
  createdAt: string;
}

const MONETIZATION_EVENTS_STORAGE_KEY =
  'despensalista.monetizationDiscoveryEvents.v1';
const MONETIZATION_EVENT_LIMIT = 20;
const PANTRY_DELETION_IDEMPOTENCY_KEY_STORAGE_KEY =
  'despensalista.pendingPantryDeletionIdempotencyKey.v1';
const PANTRY_DELETION_IDEMPOTENCY_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Component({
  selector: 'app-profile-page',
  templateUrl: './profile-page.component.html',
  styleUrl: './profile-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, ReactiveFormsModule, RouterModule],
  standalone: true,
})
export class ProfilePageComponent implements OnInit {
  private readonly formBuilder = inject(FormBuilder);
  private readonly profileService = inject(ProfileService);
  private readonly pantryService = inject(PantryService);
  private readonly authFacade = inject(AuthFacade);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly changeDetector = inject(ChangeDetectorRef);

  profile: UserProfile | null = null;
  loading = false;
  saving = false;
  exporting = false;
  loadError: string | null = null;
  saveError: string | null = null;
  saveMessage: string | null = null;
  exportError: string | null = null;
  exportMessage: string | null = null;
  deletingPantryData = false;
  deleteError: string | null = null;
  deleteMessage: string | null = null;
  deletingAccount = false;
  deleteAccountError: string | null = null;
  signingOutAllSessions = false;
  signOutAllSessionsError: string | null = null;
  householdWorkspace: HouseholdWorkspace | null = null;
  householdLoading = false;
  householdError: string | null = null;
  householdMessage: string | null = null;
  householdInviteCreating = false;
  householdAccepting = false;
  householdInviteToken: string | null = null;
  householdInviteLink: string | null = null;
  householdRevokingInviteId: string | null = null;
  householdRemovingMemberUserId: string | null = null;
  monetizationEvents: MonetizationDiscoveryEvent[] = [];
  monetizationStatus: string | null = null;
  monetizationError: string | null = null;
  private pendingPantryDeletionIdempotencyKey: PendingPantryDeletionIdempotencyKey | null =
    null;

  readonly monetizationPlans: MonetizationPlan[] = [
    {
      id: 'free',
      name: 'Free',
      priceLabel: 'MXN 0',
      statusLabel: 'Activo ahora',
      features: [
        'Inventario manual',
        'Caducidad y usar primero',
        'Lista de compras',
        'Export basico',
      ],
      boundaries: [
        'Sin cobro',
        'Sin limite de prueba artificial por ahora',
        'Sin AI remota',
      ],
    },
    {
      id: 'plus-household',
      name: 'Plus hogar',
      priceLabel: 'Precio por validar',
      statusLabel: 'Discovery',
      features: [
        'Hogar compartido completo',
        'Backups y restore/version history',
        'Reportes de ahorro y merma',
        'Planeacion multi-tienda avanzada',
      ],
      boundaries: [
        'Stripe Checkout despues de validar precio',
        'Sin checkout real en esta tanda',
        'Datos existentes quedan exportables si expira plan',
      ],
    },
    {
      id: 'ai-capture-credits',
      name: 'Creditos AI',
      priceLabel: 'Uso variable',
      statusLabel: 'Futuro',
      features: [
        'OCR de ticket',
        'Foto de anaquel',
        'Lectura de caducidad',
        'Enriquecimiento de codigo',
      ],
      boundaries: [
        'Confirmacion manual obligatoria',
        'Revision de privacidad separada',
        'Nunca AI ilimitada en lifetime',
      ],
    },
  ];

  readonly stripeReadinessItems = [
    'Proveedor decidido: Stripe para web/PWA.',
    'Checkout Sessions para suscripciones.',
    'Products y Prices como fuente de planes.',
    'Customer Portal para cambios, cancelacion y metodo de pago.',
    'Despensa Lista no guardara datos de tarjeta.',
  ];

  readonly preferencesForm = this.formBuilder.nonNullable.group({
    expirationWarningDays: [
      7,
      [Validators.required, Validators.min(1), Validators.max(60)],
    ],
    showExpiredEntryAlert: [true],
    depletionWarningThresholdRatio: [
      1,
      [Validators.required, Validators.min(0.25), Validators.max(4)],
    ],
    shoppingPlanLeadDays: [
      3,
      [Validators.required, Validators.min(0), Validators.max(30)],
    ],
    showGuidanceTips: [true],
  });

  readonly deletePantryDataForm = this.formBuilder.nonNullable.group({
    confirmationText: ['', Validators.required],
  });

  readonly deleteAccountForm = this.formBuilder.nonNullable.group({
    confirmationText: ['', Validators.required],
  });

  readonly signOutAllSessionsForm = this.formBuilder.nonNullable.group({
    confirmationText: ['', Validators.required],
  });

  readonly householdInviteForm = this.formBuilder.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    role: ['editor' as Exclude<HouseholdRole, 'owner'>, Validators.required],
  });

  readonly householdAcceptForm = this.formBuilder.nonNullable.group({
    token: ['', [Validators.required, Validators.minLength(16)]],
  });

  get canDeletePantryData(): boolean {
    return (
      !this.loading &&
      !this.deletingPantryData &&
      this.deletePantryDataForm.controls.confirmationText.value.trim() ===
        'ELIMINAR'
    );
  }

  get canManageHousehold(): boolean {
    return this.householdWorkspace?.currentMember.role === 'owner';
  }

  get canDeleteAccount(): boolean {
    return (
      !this.loading &&
      !this.deletingAccount &&
      this.deleteAccountForm.controls.confirmationText.value.trim() ===
        'ELIMINAR CUENTA'
    );
  }

  get canSignOutAllSessions(): boolean {
    return (
      !this.loading &&
      !this.signingOutAllSessions &&
      this.signOutAllSessionsForm.controls.confirmationText.value.trim() ===
        'CERRAR SESIONES'
    );
  }

  ngOnInit(): void {
    if (isPlatformBrowser(this.platformId)) {
      this.loadProfile();
      this.loadMonetizationDiscoveryEvents();
      const inviteToken =
        this.route.snapshot.queryParamMap.get('householdInvite');
      if (inviteToken) {
        this.householdAcceptForm.patchValue({ token: inviteToken });
        this.acceptHouseholdInvite();
      } else {
        this.loadHouseholdWorkspace();
      }
    }
  }

  logout(): void {
    this.authFacade.logout();
  }

  loadProfile(): void {
    this.loading = true;
    this.loadError = null;

    this.profileService
      .getProfile()
      .pipe(
        finalize(() => {
          this.loading = false;
          this.changeDetector.markForCheck();
        }),
      )
      .subscribe({
        next: (profile) => {
          this.profile = profile;
          this.preferencesForm.reset(profile.preferences);
          this.changeDetector.markForCheck();
        },
        error: (error) => {
          this.loadError = this.getErrorMessage(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  savePreferences(): void {
    if (this.preferencesForm.invalid) {
      this.preferencesForm.markAllAsTouched();
      this.saveError = 'Revisa los rangos antes de guardar preferencias.';
      this.saveMessage = null;
      return;
    }

    this.saving = true;
    this.saveError = null;
    this.saveMessage = null;

    this.profileService
      .updatePreferences(this.preferencesForm.getRawValue())
      .pipe(
        finalize(() => {
          this.saving = false;
          this.changeDetector.markForCheck();
        }),
      )
      .subscribe({
        next: (preferences) => {
          this.preferencesForm.reset(preferences);
          if (this.profile) {
            this.profile = {
              ...this.profile,
              preferences,
            };
          }
          this.saveMessage = 'Preferencias guardadas.';
          this.changeDetector.markForCheck();
        },
        error: (error) => {
          this.saveError = this.getErrorMessage(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  exportPantryData(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    this.exporting = true;
    this.exportError = null;
    this.exportMessage = null;

    this.pantryService
      .exportPantryData()
      .pipe(
        finalize(() => {
          this.exporting = false;
          this.changeDetector.markForCheck();
        }),
      )
      .subscribe({
        next: (exportData) => {
          try {
            this.downloadJson(
              exportData,
              `despensalista-export-${this.toSafeDateStamp(exportData.exportedAt)}.json`,
            );
            this.exportMessage = 'Export listo.';
          } catch (error) {
            this.exportError = this.getErrorMessage(error);
          }

          this.changeDetector.markForCheck();
        },
        error: (error) => {
          this.exportError = this.getErrorMessage(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  deletePantryData(): void {
    const confirmationText =
      this.deletePantryDataForm.controls.confirmationText.value.trim();

    if (confirmationText !== 'ELIMINAR') {
      this.deleteError = 'Escribe ELIMINAR para borrar datos locales.';
      this.deleteMessage = null;
      return;
    }

    let idempotencyKey: string;
    try {
      idempotencyKey = this.getOrCreatePantryDeletionIdempotencyKey();
    } catch (error) {
      this.deleteError = this.getErrorMessage(error);
      this.deleteMessage = null;
      return;
    }

    this.deletingPantryData = true;
    this.deleteError = null;
    this.deleteMessage = null;

    this.profileService
      .deletePantryData({ confirmationText }, idempotencyKey)
      .pipe(
        finalize(() => {
          this.deletingPantryData = false;
          this.changeDetector.markForCheck();
        }),
      )
      .subscribe({
        next: (result) => {
          this.clearPantryDeletionIdempotencyKey(idempotencyKey);
          this.deletePantryDataForm.reset({ confirmationText: '' });
          this.deleteMessage = `Datos eliminados: ${result.deletedInventoryLotCount} lotes, ${result.deletedProductTypeCount} tipos base, ${result.deletedShoppingListCount} listas guardadas, ${result.deletedShoppingShareCount} enlaces compartidos y ${result.deletedWasteEventCount} eventos de merma.`;
          this.changeDetector.markForCheck();
        },
        error: (error) => {
          this.deleteError = this.getErrorMessage(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  deleteAccount(): void {
    const confirmationText =
      this.deleteAccountForm.controls.confirmationText.value.trim();

    if (confirmationText !== 'ELIMINAR CUENTA') {
      this.deleteAccountError =
        'Escribe ELIMINAR CUENTA para borrar la cuenta.';
      return;
    }

    this.deletingAccount = true;
    this.deleteAccountError = null;

    this.profileService
      .deleteAccount({ confirmationText })
      .pipe(
        finalize(() => {
          this.deletingAccount = false;
          this.changeDetector.markForCheck();
        }),
      )
      .subscribe({
        next: () => {
          this.document.defaultView?.location.assign(
            '/login?accountDeleted=true',
          );
        },
        error: (error) => {
          this.deleteAccountError = this.getErrorMessage(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  signOutAllSessions(): void {
    const confirmationText =
      this.signOutAllSessionsForm.controls.confirmationText.value.trim();

    if (confirmationText !== 'CERRAR SESIONES') {
      this.signOutAllSessionsError =
        'Escribe CERRAR SESIONES para cerrar todos los dispositivos.';
      return;
    }

    this.signingOutAllSessions = true;
    this.signOutAllSessionsError = null;

    this.profileService
      .signOutAllSessions({ confirmationText })
      .pipe(
        finalize(() => {
          this.signingOutAllSessions = false;
          this.changeDetector.markForCheck();
        }),
      )
      .subscribe({
        next: () => {
          this.document.defaultView?.location.assign(
            '/login?sessionsRevoked=true',
          );
        },
        error: (error) => {
          this.signOutAllSessionsError = this.getErrorMessage(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  retentionPolicyLabel(profile: UserProfile): string {
    const mode = profile.retentionPolicy.archivedRecordAutoDeleteEnabled
      ? `Archivados se eliminan automaticamente despues de ${profile.retentionPolicy.archivedRecordRetentionDays} dias.`
      : `Archivados se conservan hasta restaurarlos o borrarlos manualmente. Politica configurada: ${profile.retentionPolicy.archivedRecordRetentionDays} dias si se activa auto-eliminacion.`;

    return `${mode} Enlaces temporales expiran en ${profile.retentionPolicy.temporaryShoppingShareRetentionDays} dias.`;
  }

  stepUpLabel(profile: UserProfile): string {
    const stepUp = profile.security.stepUp;

    if (!stepUp.enabled) {
      return 'Step-up esta preparado pero no exige login reciente en este ambiente.';
    }

    if (stepUp.fresh && stepUp.freshUntil) {
      return `Acciones sensibles habilitadas hasta ${this.formatCentralDate(stepUp.freshUntil)} hora Central.`;
    }

    return 'Acciones sensibles requieren volver a iniciar sesion.';
  }

  loadHouseholdWorkspace(): void {
    this.householdLoading = true;
    this.householdError = null;

    this.profileService
      .getHouseholdWorkspace()
      .pipe(
        finalize(() => {
          this.householdLoading = false;
          this.changeDetector.markForCheck();
        }),
      )
      .subscribe({
        next: (workspace) => {
          this.householdWorkspace = workspace;
          this.changeDetector.markForCheck();
        },
        error: (error) => {
          this.householdError = this.getErrorMessage(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  createHouseholdInvite(): void {
    if (this.householdInviteForm.invalid) {
      this.householdInviteForm.markAllAsTouched();
      this.householdError = 'Revisa el correo y rol de la invitacion.';
      this.householdMessage = null;
      return;
    }

    this.householdInviteCreating = true;
    this.householdError = null;
    this.householdMessage = null;
    this.householdInviteToken = null;
    this.householdInviteLink = null;

    this.profileService
      .createHouseholdInvite(this.householdInviteForm.getRawValue())
      .pipe(
        finalize(() => {
          this.householdInviteCreating = false;
          this.changeDetector.markForCheck();
        }),
      )
      .subscribe({
        next: (result) => {
          this.householdInviteToken = result.token;
          this.householdInviteLink = this.buildHouseholdInviteLink(
            result.token,
          );
          if (this.householdWorkspace) {
            this.householdWorkspace = {
              ...this.householdWorkspace,
              invites: [
                result.invite,
                ...this.householdWorkspace.invites.filter(
                  (invite) => invite.id !== result.invite.id,
                ),
              ],
            };
          }
          this.householdInviteForm.reset({
            email: '',
            role: 'editor',
          });
          this.householdMessage =
            'Invitacion creada. Comparte el enlace solo con esa persona.';
          this.changeDetector.markForCheck();
        },
        error: (error) => {
          this.householdError = this.getErrorMessage(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  acceptHouseholdInvite(): void {
    if (this.householdAccepting) return;
    if (this.householdAcceptForm.invalid) {
      this.householdAcceptForm.markAllAsTouched();
      this.householdError = 'Pega un token de invitacion valido.';
      this.householdMessage = null;
      return;
    }

    this.householdAccepting = true;
    this.householdError = null;
    this.householdMessage = null;

    this.profileService
      .acceptHouseholdInvite(this.householdAcceptForm.controls.token.value)
      .pipe(
        finalize(() => {
          this.householdAccepting = false;
          this.changeDetector.markForCheck();
        }),
      )
      .subscribe({
        next: (workspace) => {
          this.householdWorkspace = workspace;
          this.householdAcceptForm.reset({ token: '' });
          this.householdMessage = 'Invitacion aceptada.';
          if (this.route.snapshot.queryParamMap.has('householdInvite')) {
            void this.router.navigate([], {
              relativeTo: this.route,
              queryParams: { householdInvite: null },
              queryParamsHandling: 'merge',
              replaceUrl: true,
            });
          }
          this.changeDetector.markForCheck();
        },
        error: (error) => {
          this.householdError = this.getErrorMessage(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  revokeHouseholdInvite(invite: HouseholdInvite): void {
    this.householdRevokingInviteId = invite.id;
    this.householdError = null;
    this.householdMessage = null;

    this.profileService
      .revokeHouseholdInvite(invite.id)
      .pipe(
        finalize(() => {
          this.householdRevokingInviteId = null;
          this.changeDetector.markForCheck();
        }),
      )
      .subscribe({
        next: () => {
          if (this.householdWorkspace) {
            this.householdWorkspace = {
              ...this.householdWorkspace,
              invites: this.householdWorkspace.invites.filter(
                (activeInvite) => activeInvite.id !== invite.id,
              ),
            };
          }
          this.householdMessage = 'Invitacion revocada.';
          this.changeDetector.markForCheck();
        },
        error: (error) => {
          this.householdError = this.getErrorMessage(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  removeHouseholdMember(memberUserId: string): void {
    this.householdRemovingMemberUserId = memberUserId;
    this.householdError = null;
    this.householdMessage = null;

    this.profileService
      .removeHouseholdMember(memberUserId)
      .pipe(
        finalize(() => {
          this.householdRemovingMemberUserId = null;
          this.changeDetector.markForCheck();
        }),
      )
      .subscribe({
        next: (workspace) => {
          this.householdWorkspace = workspace;
          this.householdMessage = 'Miembro quitado del hogar.';
          this.changeDetector.markForCheck();
        },
        error: (error) => {
          this.householdError = this.getErrorMessage(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  roleLabel(role: HouseholdRole): string {
    const labels: Record<HouseholdRole, string> = {
      owner: 'Propietario',
      editor: 'Editor',
      viewer: 'Solo lectura',
    };

    return labels[role];
  }

  activityLabel(activity: HouseholdActivity): string {
    const role = activity.role ? ` (${this.roleLabel(activity.role)})` : '';
    const target = activity.targetLabel ? `: ${activity.targetLabel}` : '';
    const labels: Record<HouseholdActivity['type'], string> = {
      household_created: 'Hogar creado',
      invite_created: `Invitacion creada${role}`,
      invite_accepted: `Invitacion aceptada${target}${role}`,
      invite_revoked: `Invitacion revocada${role}`,
      member_removed: `Miembro quitado${target}${role}`,
      shopping_share_created: 'Lista temporal compartida',
      shopping_share_revoked: 'Lista temporal revocada',
      shopping_list_saved: `Lista guardada${target}`,
      shopping_list_deleted: `Lista guardada eliminada${target}`,
    };

    return labels[activity.type];
  }

  registerMonetizationInterest(planId: MonetizationPlanId): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    const plan = this.monetizationPlans.find((item) => item.id === planId);

    if (!plan) {
      this.monetizationError = 'Plan no reconocido.';
      this.monetizationStatus = null;
      return;
    }

    const event: MonetizationDiscoveryEvent = {
      id: this.createLocalEventId(),
      planId,
      provider: 'stripe',
      eventType: 'checkout_interest',
      createdAt: new Date().toISOString(),
    };

    const previousEvents = this.monetizationEvents;
    this.monetizationEvents = [event, ...this.monetizationEvents].slice(
      0,
      MONETIZATION_EVENT_LIMIT,
    );

    try {
      this.persistMonetizationDiscoveryEvents();
      this.monetizationError = null;
      this.monetizationStatus = `${plan.name}: interes registrado para discovery de Stripe. No se cobro nada.`;
    } catch (error) {
      this.monetizationEvents = previousEvents;
      this.monetizationStatus = null;
      this.monetizationError = this.getErrorMessage(error);
    }

    this.changeDetector.markForCheck();
  }

  clearMonetizationDiscoveryEvents(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    this.monetizationEvents = [];
    this.document.defaultView?.localStorage.removeItem(
      MONETIZATION_EVENTS_STORAGE_KEY,
    );
    this.monetizationError = null;
    this.monetizationStatus = 'Eventos locales de monetizacion limpiados.';
    this.changeDetector.markForCheck();
  }

  monetizationPlanLabel(planId: MonetizationPlanId): string {
    return (
      this.monetizationPlans.find((plan) => plan.id === planId)?.name ??
      'Plan desconocido'
    );
  }

  formatMonetizationEventCreatedAt(event: MonetizationDiscoveryEvent): string {
    return this.formatCentralDate(new Date(event.createdAt));
  }

  formatCentralDate(date: Date): string {
    return new Intl.DateTimeFormat('es-MX', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/Mexico_City',
    }).format(date);
  }

  private getErrorMessage(error: unknown): string {
    return getUserErrorMessage(error);
  }

  private getOrCreatePantryDeletionIdempotencyKey(): string {
    const ownerUserId = this.profile?.id;
    if (!ownerUserId) {
      throw new Error(
        'No se pudo identificar la cuenta que solicita el borrado.',
      );
    }
    if (
      this.pendingPantryDeletionIdempotencyKey?.ownerUserId === ownerUserId &&
      this.isCurrentPantryDeletionIdempotencyKey(
        this.pendingPantryDeletionIdempotencyKey,
      )
    ) {
      return this.pendingPantryDeletionIdempotencyKey.key;
    }

    const storage = this.document.defaultView?.localStorage;
    if (!storage) {
      throw new Error(
        'No se puede conservar el identificador seguro del borrado en este navegador.',
      );
    }

    const persisted = this.parsePantryDeletionIdempotencyKey(
      storage.getItem(PANTRY_DELETION_IDEMPOTENCY_KEY_STORAGE_KEY),
    );
    if (
      persisted?.ownerUserId === ownerUserId &&
      this.isCurrentPantryDeletionIdempotencyKey(persisted)
    ) {
      this.pendingPantryDeletionIdempotencyKey = persisted;
      return persisted.key;
    }

    const pending = {
      ownerUserId,
      key: this.createIdempotencyKey(),
      createdAt: new Date().toISOString(),
    };
    storage.setItem(
      PANTRY_DELETION_IDEMPOTENCY_KEY_STORAGE_KEY,
      JSON.stringify(pending),
    );
    this.pendingPantryDeletionIdempotencyKey = pending;
    return pending.key;
  }

  private clearPantryDeletionIdempotencyKey(idempotencyKey: string): void {
    const storage = this.document.defaultView?.localStorage;
    const persisted = this.parsePantryDeletionIdempotencyKey(
      storage?.getItem(PANTRY_DELETION_IDEMPOTENCY_KEY_STORAGE_KEY) ?? null,
    );
    if (persisted?.key === idempotencyKey) {
      storage?.removeItem(PANTRY_DELETION_IDEMPOTENCY_KEY_STORAGE_KEY);
    }
    if (this.pendingPantryDeletionIdempotencyKey?.key === idempotencyKey) {
      this.pendingPantryDeletionIdempotencyKey = null;
    }
  }

  private parsePantryDeletionIdempotencyKey(
    raw: string | null,
  ): PendingPantryDeletionIdempotencyKey | null {
    if (!raw) {
      return null;
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object') {
        return null;
      }
      const pending = value as Partial<PendingPantryDeletionIdempotencyKey>;
      return typeof pending.ownerUserId === 'string' &&
        typeof pending.key === 'string' &&
        this.isUuid(pending.key) &&
        typeof pending.createdAt === 'string'
        ? (pending as PendingPantryDeletionIdempotencyKey)
        : null;
    } catch {
      return null;
    }
  }

  private isCurrentPantryDeletionIdempotencyKey(
    pending: PendingPantryDeletionIdempotencyKey,
  ): boolean {
    const age = Date.now() - new Date(pending.createdAt).getTime();
    return (
      Number.isFinite(age) &&
      age >= 0 &&
      age < PANTRY_DELETION_IDEMPOTENCY_KEY_TTL_MS
    );
  }

  private createIdempotencyKey(): string {
    const crypto = this.document.defaultView?.crypto;
    if (!crypto) {
      throw new Error(
        'Este navegador no permite crear un identificador seguro para el borrado.',
      );
    }
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }

    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
      .slice(6, 8)
      .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  private loadMonetizationDiscoveryEvents(): void {
    const storage = this.document.defaultView?.localStorage;

    if (!storage) {
      return;
    }

    try {
      const rawEvents = storage.getItem(MONETIZATION_EVENTS_STORAGE_KEY);
      const parsedEvents: unknown = rawEvents ? JSON.parse(rawEvents) : [];

      this.monetizationEvents = Array.isArray(parsedEvents)
        ? parsedEvents
            .filter((event): event is MonetizationDiscoveryEvent =>
              this.isMonetizationDiscoveryEvent(event),
            )
            .slice(0, MONETIZATION_EVENT_LIMIT)
        : [];
    } catch {
      this.monetizationEvents = [];
      this.monetizationError =
        'No se pudieron leer eventos locales de monetizacion.';
    }
  }

  private persistMonetizationDiscoveryEvents(): void {
    const storage = this.document.defaultView?.localStorage;

    if (!storage) {
      throw new Error('Local storage no disponible.');
    }

    storage.setItem(
      MONETIZATION_EVENTS_STORAGE_KEY,
      JSON.stringify(this.monetizationEvents),
    );
  }

  private isMonetizationDiscoveryEvent(
    value: unknown,
  ): value is MonetizationDiscoveryEvent {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const event = value as Partial<MonetizationDiscoveryEvent>;
    const knownPlanIds = this.monetizationPlans.map((plan) => plan.id);

    return (
      typeof event.id === 'string' &&
      typeof event.createdAt === 'string' &&
      Number.isFinite(new Date(event.createdAt).getTime()) &&
      event.provider === 'stripe' &&
      event.eventType === 'checkout_interest' &&
      Boolean(event.planId && knownPlanIds.includes(event.planId))
    );
  }

  private createLocalEventId(): string {
    const crypto = this.document.defaultView?.crypto;

    return crypto?.randomUUID
      ? crypto.randomUUID()
      : `mon-${Date.now()}-${this.monetizationEvents.length + 1}`;
  }

  private downloadJson(data: unknown, filename: string): void {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = this.document.createElement('a');

    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  private toSafeDateStamp(value: string): string {
    return value.replace(/[:.]/g, '-');
  }

  private buildHouseholdInviteLink(token: string): string | null {
    const origin = this.document.defaultView?.location.origin;

    if (!origin) {
      return null;
    }

    return `${origin}/profile?householdInvite=${encodeURIComponent(token)}`;
  }
}
