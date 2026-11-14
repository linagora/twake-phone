# ADR 0008 : plan en étapes avec porte de sortie, PR par fonctionnalité, revue indépendante

Date : 2026-10-13. Révisé : 2026-11-14. État : acceptée. Remplacé par : aucun.

## Contexte

L'équipe développe en vibecoding : la vitesse vient de l'IA, le contrôle doit venir du processus. Le responsable produit (Clement, LINAGORA) refuse un planning en semaines et demande « des PR pour chaque feature ou correctif, avec des reviews indépendantes de roast, et des tests e2e pour tout valider ».

## Décision

- Le plan est une liste d'étapes ordonnées (README), chacune fermée par une porte de sortie : tests verts, e2e conservés, scénario de démo écrit avant de coder et joué à la fin.
- Chaque fonctionnalité ou correctif est une branche et une PR vers `main`. Rien n'est poussé sur `main` directement.
- Chaque PR reçoit une revue indépendante, menée par un relecteur sans contexte de l'auteur, avec consigne de chercher ce qui casse (« roast »). Les constats réels sont corrigés avant fusion ; ceux rejetés sont justifiés dans la PR.
- Les e2e sont la preuve : unitaires et contrat de stockage en CI sur chaque PR ; `yarn e2e:*` et `platform.e2e.mjs` sur la stack Docker à chaque porte de sortie.
- Un test n'est jamais désactivé ni mis en quarantaine pour passer.
- `.github/workflows/ci.yml` et `.github/pull_request_template.md` portent ces règles.

## Compromis

- Gagné : chaque changement est relu et prouvé par un test qui tourne.
- Perdu / coût : des e2e longs sur la stack Docker ; une revue de plus par PR.
- Limite connue : aucun banc de charge, donc aucune porte de sortie ne dit combien d'appels la stack tient.

## Alternatives écartées

- Planning en semaines : faux dès la deuxième semaine.
- Fusion directe sur `main` : pas de relecture.

## Code

`.github/workflows/ci.yml`, `.github/pull_request_template.md`.
