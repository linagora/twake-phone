# Gate check de la solution : TwakePhone

**Date :** 2026-11-02
**Méthode :** BMAD v6, fin de phase 3 (`solutioning-gate-check`)
**Documents vérifiés :** [PRD](prd-twake-phone-2026-11-02.md), [architecture](architecture-twake-phone-2026-11-02.md)

## Résumé

**Décision : passage avec réserves.** Le MVP web et l'étape 11 sont couverts par l'architecture et prouvés en e2e. Trois sujets n'ont pas encore d'architecture : le mobile, les statistiques et le rechargement de Wazo sans coupure. Ils bloquent la recette CANUT, pas la suite du développement web.

## Couverture des exigences fonctionnelles

| État | Nombre | FR |
|---|---|---|
| Fait | 21 | FR-004 à FR-010, FR-013, FR-015, FR-017 à FR-020, FR-023 à FR-025, FR-028 à FR-030, FR-032, FR-034 |
| Partiel | 12 | FR-001 à FR-003, FR-011, FR-012, FR-014, FR-016, FR-021, FR-022, FR-026, FR-031, FR-035 |
| À faire | 5 | FR-027, FR-033, FR-036, FR-037, FR-038 |

Chaque FR « Fait » ou « Partiel » a un composant dans l'architecture (§4). FR-033 (statistiques) et FR-036 (mobile) n'ont pas encore de composant.

## Couverture des exigences non fonctionnelles

| NFR | Couverte | Remarque |
|---|---|---|
| NFR-001 | Partiel | Pas de mesure sur le pilote |
| NFR-002 | Non | Un rechargement PJSIP bloque les appels ~30 s |
| NFR-003 | Partiel | `jwt` non éprouvé en réel ; secrets SIP non éphémères |
| NFR-004 | Partiel | Trunk en clair |
| NFR-005 | Oui | |
| NFR-006 | Partiel | Une seule réplique |
| NFR-007 | Partiel | Pas d'audit RGAA |
| NFR-008 | Partiel | Safari non joué |
| NFR-009 | Oui | |
| NFR-010 | Partiel | e2e 11a instable (PR #49) |
| NFR-011 | Oui | |

## Problèmes critiques

1. **Écart avec la réponse au CCTP** (Linphone, Flexisip et XiVO remplacés) : ni écrit au bénéficiaire, ni validé par lui. Risque contractuel.
2. **Mobile (§7.4.6.1)** : pas d'ADR, pas d'estimation, alors que le marché l'exige.
3. **NFR-002** : en production, chaque nouvelle ligne gèle les appels en cours d'Asterisk pendant ~30 s.

## Recommandations

1. Faire valider par le PO, puis par le bénéficiaire, le tableau des écarts du PRD (§6).
2. Écrire l'ADR du mobile et ajouter une étape 12 au plan.
3. Écrire l'ADR du chargement des lignes sans rechargement bloquant, et le prouver par un e2e : un appel en cours pendant un ajout de ligne.
4. Fusionner #49 et exiger 10 runs SIP verts de suite avant la recette.
5. Brancher le click-to-call dans Mail et la carte d'appel dans Chat (EPIC-005).

## Suite BMAD

- Phase 4 : `sprint-planning` sur EPIC-005, EPIC-009 et EPIC-008 (après son ADR), puis `create-story` story par story.
- Le statut est suivi dans [`bmm-workflow-status.yaml`](bmm-workflow-status.yaml).
