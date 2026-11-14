# ADR 0026 : « Passer en visio » : une salle de Meet restreinte, d'où chaque participant est rappelé

Date : 2026-10-19. Révisé : 2026-11-14. État : proposée. Remplacé par : aucun.

## Contexte

La conférence d'un appel (ADR 0019, 0025) vit dans une salle LiveKit à elle (`twake-call-…`), sans lien ni vidéo. Meet a ses salles, dont l'identifiant est le nom chez LiveKit. Déplacer les appels (`MoveParticipant`) est impossible : livekit-server v1.13.7 répond « not implemented » (seul LiveKit Cloud l'a).

## Décision

- Bouton « Passer en visio » si `conference.visio` ; éteint pendant l'attente de confirmation de 0025 (`CONFERENCE_AWAITING`). L'onglet s'ouvre au clic, puis va vers la salle.
- La salle de Meet est créée pour la personne avec `MeetApi.createRoom(email, { accessLevel: 'restricted' })` ; une salle plus ouverte que demandé est refusée (502).
- Le passage est un enregistrement : `POST /conferences/:id/visio` crée la fiche `visios` (migration 022), répond 202 avec le lien ; `GET` donne l'état. Un second `POST` rend le même passage ; les états changent par comparaison et échange ; un rappel resté à moitié est `interrupted`.
- Rappeler, pas déplacer, au nom de la personne, par l'autorisation de 0018 (droits, plafonds, refus de 0017). L'ancienne salle est relue avant chaque rappel. Un poste : `Replaces`, sur le dialogue lu par `roomCallParties` (appelé par cette personne, répondu par ce poste). Un numéro E.164 : nouvel appel. Tout autre : reste, `unsupported`.
- Les appels des numéros ne se terminent que sur « Terminer l'ancienne salle » (`POST /conferences/:id/visio/leave`), et seulement ceux que la passerelle a rappelés. Personne n'est laissé seul. Pendant le passage, `VISIO_IN_PROGRESS` refuse « Ajouter un participant ».
- Garde de la salle de Meet : fermée au webhook `participant_left` ou par la surveillance de 15 s, pas avant `visioGraceMs` (2 min). Les fiches terminées sont retirées à `room_finished`.

## Compromis

- Gagné : aucun appel déplacé ; accès fermé par défaut.
- Coût : un numéro entend un second appel et compte deux fois dans les plafonds un moment (403 `limit` possible). Sans `restricted` chez Meet : pas de visio (502 ; 501 `VISIO_UNAVAILABLE` sans Meet).
- Limite connue : quiconque a le numéro d'accès et le PIN de Meet entre par téléphone ; l'API de Meet utilisée ne coupe pas ce PIN. Non joué contre un vrai Meet. Sens unique. Un détournement ne rend pas les postes déjà remplacés.
- Meet : décision du 2026-11-13, voir ADR 0018 (https://github.com/suitenumerique/meet/blob/main/docs/features/telephony.md). Code pas encore aligné : `packages/conference-livekit` crée trunks, règles et PIN lui-même ; le rappel depuis la salle de Meet est un dial-out, absent de la téléphonie upstream (entrée seulement). Cette visio en dépend ; à revoir avec une PR sur suitenumerique/meet.

## Alternatives écartées

- `MoveParticipant` ou `ForwardParticipant` : non implémentés hors LiveKit Cloud.
- Donner à Meet le nom de la salle d'appel : Meet choisit le nom.
- Salle de Meet dès toute conférence : ouverte avant toute demande.
- Page vidéo à nous : un client LiveKit de plus.
- Pont SIP entre les salles : échos.

## Code

`apps/gateway/src/app.ts` (`:3649` à `:3703`), `apps/gateway/migrations/022_visios.sql`, `packages/conference-livekit/src/meet-api.ts`, `packages/provider-opensips/src/index.ts` (`roomCallParties`).
