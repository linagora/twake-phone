# ADR 0006 : application web autonome, Twake Chat l'affiche sans pile SIP

Date : 2026-10-13. Révisé : 2026-11-14. État : acceptée. Remplacé par : aucun. Décidé dans le fil de discussion du projet du 13 octobre 2026.

## Contexte

Le POC est une app Cozy dans Twake Workplace. Le besoin vise Twake Chat (Matrix). Le responsable produit veut une app autonome, intégrable dans Twake Chat, mais Twake Chat est secondaire pour l'instant.

## Décision

- TwakePhone est une application web React autonome (`apps/web`), sur son propre domaine, authentifiée par OIDC (PKCE) sur LemonLDAP::NG (`apps/web/src/auth/oidc.ts`).
- Twake Chat l'intègre plus tard (étape 9) par la grille d'apps, un widget Matrix, les liens `tel:`, une carte d'appel to-device et la présence. Le code de Twake Chat reste sans SIP.
- L'app Phone du POC (`apps/phone`, Cozy) est remplacée par `apps/web` à l'étape 2 et retirée du dépôt à la PR 3c.
- `phone-link` et `phone-widget` restent utilisables pour Twake Workplace.
- CSP (`frame-ancestors`, `connect-src` vers la passerelle et le WSS) réglée à l'étape 2.
- Suite : ADR 0031 (lien `tel:`), 0032 (coquille Cozy dans Workplace), 0034 (widget télécommande).

## Compromis

- Gagné : Twake Chat n'a aucune pile SIP à maintenir ; l'app vit à son rythme.
- Perdu / coût : une app de plus pour l'utilisateur, un onglet à ouvrir ; l'intégration dans Chat reste partielle (ADR 0031 : lien et grille d'apps seulement).
- Limite connue : le widget, la carte d'appel et la présence attendent.

## Alternatives écartées

- Téléphonie embarquée dans Twake Chat : une pile SIP dans un client Flutter tenu par une autre feuille de route.

## Code

`apps/web`, `packages/phone-link`, `packages/phone-widget`.
