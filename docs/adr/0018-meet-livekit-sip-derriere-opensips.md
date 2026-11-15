# ADR 0018 : Meet entre par la téléphonie de Meet upstream, LiveKit SIP derrière OpenSIPS

Date : 2026-10-16. Révisé : 2026-11-14. État : acceptée, code pas encore aligné. Remplacé par : aucun. Décidée à la PR de l'étape 8a, dans le fil de discussion du projet.

## Contexte

L'étape 8a avait fait entrer les appels dans Meet par LiveKit SIP, avec un trunk, des règles de dispatch, des PIN et un dial-out écrits par notre passerelle. Le 2026-11-13, Clément a décidé de passer par la téléphonie de Meet upstream ([telephony.md](https://github.com/suitenumerique/meet/blob/main/docs/features/telephony.md)) et de ne plus tenir ce modèle chez nous. Meet est sous licence MIT ([source](https://github.com/suitenumerique/meet)), LiveKit et LiveKit SIP sous Apache-2.0 ([livekit](https://github.com/livekit/livekit), [sip](https://github.com/livekit/sip)).

## Décision

- Décision du 2026-11-13 : le backend de Meet tient le PIN et crée puis efface la règle de dispatch de LiveKit à `room_started` et `room_ended`. Un seul trunk. Entrée seulement, pas de dial-out. Pas d'entrée avant le premier participant WebRTC.
- Des PR sur `suitenumerique/meet` si un besoin manque ; rien n'est forké.
- LiveKit SIP reste derrière OpenSIPS (socket à lui `MEET_LISTEN_IP:MEET_PORT`, `MEET_SIP`) et rtpengine reste des deux côtés de l'appel : à confirmer avec Meet upstream.
- Un numéro d'accès, `MEET_NUMBER` (8000 par défaut), mène aux salles depuis un poste ou depuis l'opérateur (`target` d'une plage de `dids`).
- Code pas encore aligné : `packages/conference-livekit` fait encore l'ancien modèle, décrit ci-dessous, jusqu'à son remplacement.
- Dépendants à revoir : ADR 0019, 0025 et 0026 reposent sur le dial-out (la salle appelle une personne ou un numéro) ; le rappel depuis la salle n'existe pas dans Meet upstream.

## Séquence

```mermaid
sequenceDiagram
  participant T as Téléphone
  participant O as OpenSIPS
  participant S as LiveKit SIP
  participant M as Backend Meet
  participant L as LiveKit
  L-->>M: webhook room_started
  M->>S: crée la règle de dispatch (PIN de la salle)
  T->>O: INVITE MEET_NUMBER
  O->>S: INVITE (socket MEET_SIP)
  S-->>T: demande le PIN (DTMF)
  T->>S: PIN
  S->>S: règle trouvée pour le PIN et le trunk
  S->>L: le téléphone rejoint la salle
  L-->>M: webhook room_ended
  M->>S: efface la règle
```

Modèle cible, tiré de la doc de Meet upstream (https://github.com/suitenumerique/meet/blob/main/docs/features/telephony.md). Le passage par OpenSIPS est à confirmer avec Meet upstream.

## Code actuel, ancien modèle

- La passerelle crée les trunks et les règles `dispatch_rule_direct` de LiveKit, tire le PIN de chaque salle et les nettoie (`packages/conference-livekit`, `conference-sweep.ts`).
- OpenSIPS n'ouvre le socket de LiveKit SIP qu'à `MEET_SIP`, compte les essais de PIN et les appels (`cachedb_local`, profils de dialogue) et borne leur durée (`MEET_MAX_CALL_SEC`).
- Dial-out : la salle appelle par OpenSIPS avec une autorisation de la passerelle (`dial_out_grants`, `X-Twake-Grant`), sous les droits et plafonds du poste demandeur, jamais une urgence.
- Média par rtpengine, sans transcodage (ADR 0030). Versions figées dans `docker/docker-compose.sip.yml`.
- `MEET_INBOUND_ADDRESSES` est obligatoire. Les journaux de LiveKit montrent les PIN : niveau `warn` recommandé.
- Valeurs et codes de refus : `docker/opensips/entrypoint.sh` et `packages/conference-livekit/src`.

## Compromis

- Gagné : un seul modèle de PIN et de salle, celui de Meet ; moins de code à nous à garder en phase avec LiveKit.
- Perdu / coût : plus de dial-out ni de rappel depuis la salle, donc les conférences d'appel (ADR 0019, 0025, 0026) perdent leur chemin ; pas d'entrée avant le premier participant WebRTC.
- Limite connue : rien n'est vérifié contre une instance de Meet (règles de PIN, numéro montré) ni contre un vrai trunk OVHcloud ; un numéro d'accès par plateforme (une base OpenSIPS sert un tenant, ADR 0016) ; comptes de PIN en mémoire, remis à zéro au redémarrage ; un attaquant qui change de numéro à chaque appel n'est pas borné en nombre d'essais, l'alerte le signale.

## Alternatives écartées

- LiveKit SIP branché directement sur le trunk de l'opérateur : l'opérateur verrait deux plateformes, les droits et plafonds seraient contournés.
- Un compte `subscriber` pour LiveKit SIP : il pourrait s'enregistrer et être appelé.
- Un en-tête signé (HMAC) plutôt qu'une ligne en base : rejouable jusqu'à son échéance.
- Un numéro direct par salle : numéros rares et payants pour des salles éphémères.
- Le média du navigateur directement vers LiveKit SIP : il ne parle que RTP simple, rtpengine est le seul chemin du média (ADR 0004).

## Code

`packages/conference-livekit`, `docker/docker-compose.sip.yml`, `docker/opensips/opensips.cfg.tpl` (`MEET_*`, `failure_route[meet_failed]`), `apps/gateway/src/conference-sweep.ts`.
