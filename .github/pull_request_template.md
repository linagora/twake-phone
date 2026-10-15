## Avant

<!-- Ce qu'un utilisateur ou un développeur voit aujourd'hui, en deux phrases. -->

## Après

<!-- Ce qu'il voit avec cette PR. -->

## Comment

<!-- Le choix technique, en un paragraphe. Lien vers l'ADR si une décision est prise ou changée. -->

## Étape du plan

<!-- Numéro de l'étape du README et, si la PR la termine, le scénario de démo joué. -->

## Preuves

- [ ] `yarn build && yarn typecheck && yarn lint && yarn test` verts
- [ ] e2e joués sur la stack Docker (lesquels, et leur résultat) ou raison de ne pas les jouer
- [ ] Revue indépendante (roast) faite ; constats corrigés ou réponse dans la PR
- [ ] Aucune notion d'un fournisseur hors de son `provider-*`, aucune notion LiveKit ou Meet hors de `conference-livekit`
- [ ] Aucun secret, aucun `.env` commité
