# ADR 0026 : « Passer en visio » : une salle de Meet à accès restreint, d'où chaque participant de la conférence est rappelé ; aucun appel n'est déplacé

Date : 2026-10-19. État : proposée. Décidée à la PR de l'étape 8d, dans le fil de discussion du projet (ligne « 8. Meet et conférence » du plan ; suite des ADR 0019 et 0025) ; remplacé par : aucun.

## Contexte

La conférence d'un appel (ADR 0019, 0025) vit dans une salle de LiveKit à elle (`twake-call-…`) : ni lien, ni page, ni vidéo. Meet a ses salles : leur identifiant est aussi leur nom chez LiveKit (on ne le choisit pas), et seul le jeton de Meet fait entrer un navigateur. Pour que la personne ouvre la visio de sa conférence, il faut donc que les participants soient dans une salle de Meet.

Une première version déplaçait leurs appels d'une salle à l'autre (`MoveParticipant` de LiveKit). Elle ne peut pas marcher : dans livekit-server v1.13.7 (celui de la pile), `MoveParticipant` et `ForwardParticipant` répondent « not implemented ». Seul LiveKit Cloud les a.

## Décision

**Le geste.** Dans la conférence qu'elle a faite, la personne a un bouton « Passer en visio », offert quand la plateforme a Meet (`conference.visio` des capacités, lu à l'ouverture de la conférence). Il est éteint tant qu'un appel avec l'opérateur attend sa confirmation (ADR 0025) : la conférence n'est alors pas encore faite, et la passerelle refuse aussi (409 `CONFERENCE_AWAITING`). Le clic ouvre aussitôt un onglet vide (c'est le clic qui l'ouvre : un bloqueur de fenêtres le laisse faire), coupé de la page, que la fenêtre dirige vers la salle de Meet quand la passerelle l'a faite ; il se ferme si elle échoue.

**La salle de Meet.** Meet la crée pour la personne (son courriel, comme à l'étape 8a) avec l'accès **le plus fermé que Meet donne : `restricted`** (ni `public`, ni `trusted`). La passerelle demande ce niveau et **refuse une salle plus ouverte** que demandé (une version de Meet qui l'ignorerait : 502, rien n'est appelé) : `MeetApi.createRoom(email, { accessLevel })`. Qui peut y entrer : par le navigateur, seuls ceux que Meet admet dans une salle restreinte, c'est-à-dire sa propriétaire et ceux qu'elle y invite dans Meet ; avoir le lien ne suffit pas. Par le téléphone, seuls ceux que la passerelle appelle depuis la salle (point suivant) : le numéro d'accès et le PIN de la salle (ADR 0018) existent chez Meet comme pour toute salle, mais la passerelle ne les montre à personne ici. La salle est celle de la personne (`claimConference`, comme une salle ouverte chez Meet), avec la garde de l'étape 8a.

**Rappeler, pas déplacer.** Depuis la salle de Meet, la passerelle appelle chaque participant de la conférence (hors la personne), au nom de la personne, par l'autorisation à usage unique de l'ADR 0018 (`dial_out_grants`), donc sous les mêmes droits, plafonds, refus et durée que tout appel d'une salle (ADR 0017) :
- **un poste** (`Replaces`, comme à l'étape 8b) : la passerelle lit le dialogue de l'appel de l'ancienne salle chez OpenSIPS (`roomCallParties`, MI `dlg_list_ctx` : un appel que la salle a passé à une extension, répondu) et nomme ce dialogue dans l'autorisation. OpenSIPS écrit `Replaces` ; le navigateur du poste répond aussitôt, sans sonner, et termine l'appel remplacé. Rien n'est raccroché avant que le nouvel appel soit là, et un poste qui le refuse (en attente, dans un autre appel) garde le sien ;
- **un numéro du réseau public** : un nouvel appel, comme le rappel de l'ADR 0025 (même autorisation, mêmes contrôles de l'opérateur).
Qui ne peut pas être rappelé (dialogue introuvable, appel refusé, sans réponse) reste dans l'ancienne salle, et la réponse le dit (`failed`). Un appel détourné (ADR 0019) met fin à tout (502, la salle de Meet n'est pas gardée, l'ancienne salle ne change pas).

**Ce qui se termine, et quand** (même logique que la confirmation de l'ADR 0025) : les appels des postes se terminent d'eux-mêmes (le `Replaces`). Pour les numéros du réseau public, un répondeur de l'opérateur peut décrocher le rappel, et le vrai correspondant serait alors perdu : leur ancien appel et l'appel de la personne dans l'ancienne salle sont **gardés** jusqu'à ce que la personne dise qu'elle les entend dans la salle de Meet (« Terminer l'ancienne salle », `POST /conferences/:id/visio/leave`, avec la salle de Meet) ; la passerelle ne met alors fin qu'aux participants dont le numéro est dans la salle de Meet (et à l'appel de la personne), puis supprime l'ancienne salle s'il n'y reste personne. Rejouable, sans état en mémoire (la salle et ses participants se relisent chez LiveKit). Sans numéro du réseau public à rappeler ni échec, l'appel de la personne se termine tout de suite (sa voix passe par la visio) et il n'y a rien à confirmer.

## Conséquences

Aucun appel n'est déplacé : chaque participant a, un instant, deux appels (l'ancienne salle et Meet), sauf les postes, qui ne voient qu'un remplacement. Aucune notion de Meet ou de LiveKit hors de `packages/conference-livekit` ; le fournisseur dit seulement le dialogue d'un appel de salle (`roomCallParties`).

Limites, assumées :
- **Les numéros extérieurs entendent un second appel**, et sont comptés deux fois un moment dans les plafonds et les minutes réservées de la personne (ADR 0025) : un plafond d'un appel externe à la fois refuse le rappel (le participant reste dans l'ancienne salle).
- **Le panneau d'un collègue au téléphone** qui a changé de salle ne montre plus la liste des participants (l'en-tête de la nouvelle salle nomme une salle de Meet, que son navigateur ne lit pas) : son appel continue, avec « Quitter la conférence ».
- **L'accès `restricted` demande à Meet de l'avoir.** Sans lui, pas de visio (502 à la création de la salle ; 501 `VISIO_UNAVAILABLE` sans Meet du tout) : on ne choisit pas une salle plus ouverte. Les participants ajoutés par le lien d'un autre navigateur doivent être invités dans Meet.
- **Non joué contre un vrai Meet** : l'e2e joue son API externe et la page de la salle, contre le vrai LiveKit et le vrai LiveKit SIP.
- **Sens unique** : la salle de Meet ne redevient pas une salle d'appel.

## Alternatives écartées

- **Déplacer les appels (`MoveParticipant`) ou les transférer (`ForwardParticipant`)** : « not implemented » sur le LiveKit libre.
- **Donner à Meet le nom de la salle d'appel** : Meet ne laisse pas choisir le nom de sa salle.
- **Une salle de Meet dès la création de toute conférence** : une salle de Meet par « Ajouter un participant », ouverte à qui a le lien avant que personne n'ait demandé la visio, et un identifiant de Meet à accepter là où quatre expressions régulières attendent `twake-call-…`.
- **Une page vidéo à nous avec un client LiveKit** : de la vidéo et un client LiveKit de plus dans l'application, alors que Meet fait cela.
- **Un pont audio SIP entre les deux salles** : chaque salle entendrait l'autre, puis soi-même en écho.
