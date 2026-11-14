import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-privacy-page',
  standalone: true,
  imports: [CommonModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="legal-page" aria-labelledby="privacy-title">
      <article class="legal-document">
        <p class="eyebrow">Despensa Lista</p>
        <h1 id="privacy-title">Politica de privacidad</h1>
        <p class="updated">Última actualización: 13 de noviembre de 2026</p>

        <p>
          Despensa Lista ayuda a organizar productos del hogar, lotes,
          caducidades, listas de compra y preferencias de despensa. Esta
          politica explica que datos tratamos y como puedes pedir acceso,
          exportacion o eliminacion.
        </p>

        <h2>Responsable</h2>
        <p>
          Despensa Lista es operada por Lynx Pardelle para el dominio despensalista.com.
        </p>

        <h2>Datos que recopilamos</h2>
        <ul>
          <li>
            Datos de cuenta recibidos desde Amazon Cognito y proveedores de
            inicio de sesion, como correo, nombre y proveedor usado.
          </li>
          <li>
            Datos que capturas en la app: productos, cantidades, unidades,
            caducidades, notas, ubicaciones, listas de compra y eventos de
            consumo o desperdicio.
          </li>
          <li>
            Datos tecnicos necesarios para seguridad y operacion, como cookies
            de sesion, registros de actividad de cuenta, errores y metricas
            agregadas.
          </li>
        </ul>

        <h2>Google y proveedores sociales</h2>
        <p>
          Si eliges iniciar sesion con Google o con otro proveedor social
          habilitado, Despensa Lista usa Amazon Cognito para solicitar el
          acceso basico necesario: identificador de cuenta, correo, nombre y
          perfil basico segun el proveedor. No publicamos contenido en tus
          cuentas sociales y no vendemos estos datos.
        </p>

        <h2>Pagos y suscripción</h2>
        <p>
          Si contratas Plus Hogar, Stripe procesa el pago y recoge directamente los datos de
          facturación y de la tarjeta en su página de pago. Despensa Lista no recibe ni almacena
          el número de tarjeta ni el código de seguridad. Usamos el identificador del hogar,
          las referencias de Stripe y el estado de pago para conciliar los cobros, activar el
          plan y gestionar la suscripción.
        </p>
        <p>
          Conservamos los registros de facturación necesarios para atender la suscripción,
          conciliar pagos y cumplir las obligaciones aplicables.
          <a routerLink="/terminos-plus-hogar">Consulta las condiciones de Plus Hogar.</a>
        </p>

        <h2>Como usamos los datos</h2>
        <ul>
          <li>Crear y proteger tu cuenta.</li>
          <li>Guardar y sincronizar tu despensa y listas de compra.</li>
          <li>Mostrar recordatorios, resumenes y exportaciones que solicites.</li>
          <li>Prevenir abuso, diagnosticar errores y mantener el servicio.</li>
        </ul>

        <h2>Con quien compartimos datos</h2>
        <p>
          Usamos servicios de AWS para autenticar, almacenar y ejecutar la app.
          Tambien usamos Google u otro proveedor social solo cuando eliges ese
          proveedor para iniciar sesion. No vendemos datos personales ni
          compartimos el contenido de tu despensa con anunciantes.
        </p>

        <h2>Retencion y eliminacion de datos</h2>
        <p>
          Conservamos datos mientras tu cuenta este activa o mientras sean
          necesarios para operar la app. Desde el perfil puedes exportar datos,
          cerrar sesiones y eliminar tu cuenta. La eliminacion de cuenta borra
          la identidad de Cognito y los registros de despensa asociados segun
          las reglas tecnicas disponibles.
        </p>

        <h2 id="eliminacion-de-datos">Instrucciones de eliminacion de datos</h2>
        <ol>
          <li>Inicia sesion en Despensa Lista.</li>
          <li>Abre Perfil.</li>
          <li>Usa la accion de eliminacion de cuenta y confirma el texto pedido.</li>
          <li>
            Si no puedes iniciar sesion, usa el canal de soporte configurado en
            la ficha de la app en Meta o Google para solicitar eliminacion.
          </li>
        </ol>

        <h2>Tus controles</h2>
        <ul>
          <li>Puedes exportar datos desde la app.</li>
          <li>Puedes revocar enlaces temporales de listas compartidas.</li>
          <li>Puedes pedir cierre de sesiones desde el perfil.</li>
          <li>Puedes eliminar tu cuenta cuando ya no quieras usar el servicio.</li>
        </ul>

        <h2>Seguridad</h2>
        <p>
          La app usa HTTPS, cookies HttpOnly para la sesion, controles de
          autenticacion con Cognito y almacenamiento en AWS. Ningun sistema es
          perfecto, pero mantenemos controles razonables para reducir acceso no
          autorizado.
        </p>

        <h2>Cambios</h2>
        <p>
          Podemos actualizar esta politica cuando cambie el servicio. La fecha
          de actualizacion indicara la version vigente.
        </p>

        <a class="home-link" routerLink="/login">Volver a Despensa Lista</a>
      </article>
    </main>
  `,
  styles: [
    `
      .legal-page {
        width: min(900px, calc(100% - 2rem));
        margin: 0 auto;
        padding: 2rem 0 4rem;
      }

      .legal-document {
        background: rgba(255, 250, 242, 0.94);
        border: 1px solid rgba(120, 83, 58, 0.18);
        border-radius: 8px;
        box-shadow: var(--shadow-soft);
        padding: clamp(1.25rem, 4vw, 2.5rem);
      }

      .eyebrow,
      .updated {
        color: var(--color-text-muted);
      }

      .eyebrow {
        margin: 0 0 0.75rem;
        font-size: 0.82rem;
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }

      h1 {
        margin: 0;
        font-size: clamp(2.25rem, 6vw, 3.5rem);
      }

      h2 {
        margin: 2rem 0 0.75rem;
        font-size: clamp(1.2rem, 3vw, 1.55rem);
      }

      p,
      li {
        line-height: 1.7;
      }

      ul,
      ol {
        padding-left: 1.35rem;
      }

      .home-link {
        display: inline-block;
        margin-top: 1.5rem;
        color: var(--color-accent-deep);
        font-weight: 700;
        text-decoration: none;
      }

      .home-link:hover,
      .home-link:focus-visible {
        text-decoration: underline;
      }
    `,
  ],
})
export class PrivacyPageComponent {}
