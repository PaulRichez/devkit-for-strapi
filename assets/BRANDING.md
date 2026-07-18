# DevKit for Strapi — Mini charte

> Placeholder professionnel, remplaçable. Source de vérité : `icon.svg`.

## Concept

Des accolades `{ }` (le code) entourant un **check** (la référence *juste*, validée).
Résume la promesse : « là où Copilot devine, l'extension garantit ».

## Couleurs

| Rôle              | Hex       | Usage                                              |
| ----------------- | --------- | -------------------------------------------------- |
| Violet Strapi     | `#4945FF` | Couleur de marque, `galleryBanner.color`, fond bas |
| Violet clair      | `#8A88FF` | Haut du dégradé d'icône                            |
| Blanc             | `#FFFFFF` | Glyphe (accolades + check)                          |

Le dégradé d'icône va de `#8A88FF` (haut-gauche) à `#4945FF` (bas-droite).

## Assets

| Fichier         | Format         | Usage                                                 |
| --------------- | -------------- | ----------------------------------------------------- |
| `icon.svg`      | SVG (master)   | Source de vérité, README, scalable                     |
| `icon-128.png`  | PNG 128×128    | `package.json` `icon` (Marketplace + Open VSX)         |
| `banner.png`    | PNG large      | Bannière marketplace (optionnel)                       |

`galleryBanner` : `{ "color": "#4945FF", "theme": "dark" }`.

## Génération du PNG

Le PNG 128×128 est dérivé de `icon.svg` et **commité** (packaging déterministe) :

```sh
# au choix : sharp, resvg, ou Inkscape
npx --yes sharp-cli -i assets/icon.svg -o assets/icon-128.png resize 128 128
# ou
inkscape assets/icon.svg --export-type=png -w 128 -h 128 -o assets/icon-128.png
```

## Règles d'usage

- Garder la zone de respiration (le rayon d'angle `28` sur 128 px).
- Ne pas déformer le ratio ; fond non transparent pour le PNG marketplace.
- Le glyphe reste blanc plein sur fond violet.

## Marque « Strapi » (à respecter)

« Strapi » est une **marque déposée de Strapi SAS**. Règles qu'on s'impose :

- **Logo maison uniquement** — ne **jamais** utiliser le logo officiel Strapi (on a le nôtre).
- **Disclaimer de non-affiliation** présent dans les README (extension + racine) :
  *« not affiliated with, endorsed by, or sponsored by Strapi SAS ».*
- **Nom (décidé)** : le `displayName` Marketplace est **« DevKit for Strapi »** (la marque ne mène
  pas — la forme la plus défendable). Le package npm publié est `devkit-for-strapi` (non scopé,
  convention communautaire « strapi-* ») ; les packages internes sont eux aussi **non scopés** et
  alignés sur le produit : `devkit-for-strapi-core` / `devkit-for-strapi-test-fixtures` (privés/non
  publiés) — pas de scope perso. Un futur package publié (ex. MCP) restera sous un nom neutre,
  jamais `@strapi*`.
