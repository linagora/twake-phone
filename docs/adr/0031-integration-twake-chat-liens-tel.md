# ADR 0031 : Twake Chat ouvre TwakePhone sur un numéro (`/?dial=`), le reste de l'intégration attend

Date : 2026-10-20. Révisé : 2026-11-14. État : proposée. Remplacé par : aucun. Suit l'ADR 0006.

## Contexte

Chat souligne les numéros en liens `tel:`, que le navigateur confie à l'application de l'appareil, pas à TwakePhone. La démo de l'étape 9 est : un numéro cliqué dans Chat prépare l'appel. Les leçons du POC pèsent sur le widget (cadre écrasé, toutes les fenêtres sonnent, origine de confiance).

## Décision

- Contrat : `GET <TwakePhone>/?dial=<numéro>`. TwakePhone seul valide et normalise (`toDialTarget` : poste de 2 à 6 chiffres, ou E.164, France par défaut) ; Chat ne nettoie que chiffres et `+`. Un numéro invalide ne compose rien. Le paramètre est retiré de la barre d'adresse ; un second lien remplace le premier.
- Le lien ne compose jamais : le numéro est mis dans le champ, le focus va à « Appeler », l'appel part au clic ou à Entrée. Sinon n'importe quelle page ferait composer un numéro surtaxé (les droits et plafonds de 0017 limitent, n'empêchent pas).
- Chat ouvre TwakePhone dans son propre onglet, pas un widget : `FRAME_ANCESTORS` ne change pas. Avec `TWAKE_PHONE_URL`, la grille d'apps de Chat propose « TwakePhone » ; sinon Chat garde ses `tel:`. Avec la barre de la plateforme, l'entrée vient de sa liste d'apps, hors de ce dépôt.
- Le numéro passe dans la requête : un proxy devant `apps/web/server` peut le journaliser, à traiter comme une donnée personnelle.

## Compromis

- Gagné : aucune dépendance de TwakePhone envers Chat, ni de Chat envers SIP (0006) ; un seul endroit valide les numéros.
- Coût : un geste de plus à la démo, voulu.
- Limite connue : widget, carte d'appel et présence dans Chat ne sont pas faits (le widget a une autre forme depuis 0032 et 0034) ; un appel entrant ne se voit dans Chat que si TwakePhone est ouvert. Le bot est fait pour la messagerie (0023). Le côté Chat est testé dans son dépôt.

## Alternatives écartées

- Composer à l'ouverture du lien : risque ci-dessus.
- `postMessage` vers une fenêtre déjà ouverte : une seconde origine ne se parle pas sans lien de confiance (repris en 0032).
- Bibliothèque de validation dans Chat : TwakePhone fait foi.

## Code

`packages/telephony-client/src/index.ts` (`toDialTarget`), `apps/web/src/` (clavier), `apps/web/server/`, `apps/web/test/` (`yarn e2e:web`).
