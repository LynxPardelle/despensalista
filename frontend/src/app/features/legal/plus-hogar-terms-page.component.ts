import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { plusHogarTermsVersion } from '../../core/services/billing.service';

@Component({
  selector: 'app-plus-hogar-terms-page',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="legal-page" aria-labelledby="plus-terms-title">
      <article>
        <h1 id="plus-terms-title">Condiciones de Plus Hogar</h1>
        <p>Versión {{ termsVersion }}</p>

        <h2>Precio y renovación</h2>
        <p>
          Plus Hogar es una suscripción para un hogar de DespensaLista. Antes de autorizar el cobro,
          el perfil muestra el total mensual con IVA y el desglose. Stripe también muestra el total
          antes de confirmar el pago.
          El primer cargo se realiza al confirmar el pago en Stripe. Después se realizan cobros
          automáticos cada mes hasta que canceles la renovación. Consulta el periodo actual en tu perfil.
        </p>

        <h2>Cancelación</h2>
        <p>
          En Perfil, selecciona «Gestionar suscripción en Stripe» para cancelar la renovación sin
          penalización. La cancelación de la renovación se registra al confirmarla. El hogar conserva
          el acceso de Plus hasta que termina el periodo pagado.
        </p>
        <p>
          Si la persona propietaria elimina su cuenta, la suscripción se cancela de inmediato y
          termina el acceso de Plus. Los registros de facturación se conservan conforme a las
          obligaciones aplicables.
        </p>

        <h2>Estado del pago</h2>
        <p>
          El acceso de Plus se activa cuando Stripe confirma el pago. Si un cobro falla, la persona
          propietaria puede revisar la suscripción y actualizar su forma de pago en el portal de Stripe.
        </p>

        <h2>Factura fiscal</h2>
        <p>
          ZooBeriah emite el CFDI. Puedes solicitarlo desde tu perfil o escribir a
          <a href="mailto:facturas@despensalista.com">facturas@despensalista.com</a>.
        </p>

        <p class="links">
          <a routerLink="/profile">Volver al perfil</a>
          <a routerLink="/privacidad">Política de privacidad</a>
        </p>
      </article>
    </main>
  `,
  styles: `
    .legal-page {
      width: min(900px, calc(100% - 2rem));
      margin: 0 auto;
      padding: 2rem 0 4rem;
    }

    article {
      background: rgba(255, 250, 242, 0.94);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      padding: clamp(1.25rem, 4vw, 2.5rem);
    }

    h2 {
      margin-top: 1.75rem;
      font-size: 1.3rem;
    }

    p {
      line-height: 1.7;
    }

    .links {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
    }
  `,
})
export class PlusHogarTermsPageComponent {
  protected readonly termsVersion = plusHogarTermsVersion;
}
