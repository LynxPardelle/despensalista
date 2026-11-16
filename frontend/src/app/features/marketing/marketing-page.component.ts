import { ChangeDetectionStrategy, Component, DOCUMENT, inject } from '@angular/core';
import { Meta, Title, type MetaDefinition } from '@angular/platform-browser';
import { ActivatedRoute } from '@angular/router';

const siteOrigin = 'https://despensalista.com';

@Component({
  selector: 'app-marketing-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './marketing-page.component.html',
  styleUrl: './marketing-page.component.scss',
})
export class MarketingPageComponent {
  readonly showPlans = inject(ActivatedRoute).snapshot.data['showPlans'] === true;

  constructor() {
    const title = this.showPlans
      ? 'Planes Gratis y Plus Hogar | DespensaLista'
      : 'DespensaLista | Tu despensa, a la vista';
    const description = this.showPlans
      ? 'Compara Gratis y Plus Hogar. Organiza tu despensa, comparte listas de compras y elige el espacio que necesita tu hogar.'
      : 'Ve qué tienes en casa, qué conviene usar primero y qué te falta comprar. Organiza tu despensa y comparte la lista de compras con tu hogar.';
    const canonicalUrl = `${siteOrigin}${this.showPlans ? '/planes' : '/'}`;
    const document = inject(DOCUMENT);
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
      ?? document.createElement('link');

    canonical.rel = 'canonical';
    canonical.href = canonicalUrl;
    if (!canonical.parentNode) document.head.appendChild(canonical);

    inject(Title).setTitle(title);
    const meta = inject(Meta);
    const tags: MetaDefinition[] = [
      { name: 'description', content: description },
      { property: 'og:type', content: 'website' },
      { property: 'og:locale', content: 'es_MX' },
      { property: 'og:site_name', content: 'DespensaLista' },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:url', content: canonicalUrl },
      { property: 'og:image', content: `${siteOrigin}/marketing/despensa-social.jpg` },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      { property: 'og:image:alt', content: 'Una despensa con frascos de arroz y frijoles' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ];
    for (const tag of tags) {
      meta.updateTag(tag);
    }
  }
}
