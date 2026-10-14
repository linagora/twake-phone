# ADR 0006 : application autonome, Twake Chat l'affiche sans pile SIP

Date : 2026-10-13. État : acceptée. Décidé dans le fil de discussion du projet du 13 octobre 2026 ; remplacé par : aucun.

## Contexte

Le POC est une app Cozy dans Twake Workplace. Le besoin vise Twake Chat (Matrix). Le responsable produit veut une app autonome, intégrable dans Twake Chat, mais Twake Chat est secondaire pour l'instant.

## Décision

TwakePhone est une application web React autonome, sur son propre domaine, authentifiée par OIDC (PKCE) sur LemonLDAP::NG. Twake Chat l'intègre plus tard (étape 9) par la grille d'apps, un widget Matrix, les liens `tel:`, une carte d'appel to-device et la présence ; le code de Twake Chat reste sans SIP.

## Conséquences

- `apps/phone` sort de Cozy à l'étape 2 (cozy-client, cozy-ui et cozy-interapp retirés).
- `phone-link` et `phone-widget` restent utilisables pour Twake Workplace.
- CSP (`frame-ancestors`, `connect-src` vers la passerelle et le WSS) réglée à l'étape 2.

## Alternatives écartées

Téléphonie embarquée dans Twake Chat : une pile SIP dans un client Flutter tenu par une autre feuille de route.
