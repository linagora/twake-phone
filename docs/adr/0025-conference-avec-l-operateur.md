# ADR 0025 : un appel avec l'opérateur devient une conférence en rappelant le numéro depuis la salle, sous les mêmes droits et plafonds que tout appel de la personne

Date : 2026-10-19. État : proposée. Décidée à la PR de l'étape 8c, dans le fil de discussion du projet (ligne « 8. Meet et conférence » du plan ; suite de l'ADR 0019, qui laissait « la conférence d'un appel avec l'opérateur » de côté) ; remplacé par : aucun.

## Contexte

L'ADR 0019 fait d'un appel entre deux postes une conférence : la salle de LiveKit appelle l'autre poste à la place de l'appel (`Replaces`). Avec l'opérateur, c'est impossible sans B2BUA (ADR 0004, 0018, 0019) : OpenSIPS est un proxy, le dialogue de l'opérateur a pour autre bout le navigateur, et un opérateur n'accepte pas de `Replaces`. Il reste deux demandes : qu'un appel avec un numéro extérieur puisse devenir une conférence, et qu'on puisse ajouter un numéro extérieur à une conférence (ce que fait déjà `POST /conferences/:id/participants` de l'étape 8a, avec les droits, les plafonds et le numéro direct de la personne).

## Décision

**Le geste est le même** (« Ajouter un participant » dans un appel répondu, `POST /calls/:id/conference` avec le jeton de la fenêtre). Ce qui change est ce que la salle fait de l'autre partie : elle ne la remplace pas, elle la **rappelle**.

1. La passerelle lit le dialogue chez OpenSIPS (MI `dlg_list_ctx`), jamais chez le navigateur. Pour un appel avec l'opérateur, le fournisseur rend le poste de la personne et le numéro de l'autre partie : le numéro composé (`$dlg_val(dialled)`, en E.164, écrit à l'envoi vers l'opérateur) pour un appel passé, ou le numéro présenté (`$dlg_val(cli)`, nouveau, écrit à l'arrivée d'un appel de l'opérateur) pour un appel reçu. Le `From` du dialogue n'est jamais lu : il garde un numéro qui a demandé à ne pas être montré.
2. Sont refusés avec `CONFERENCE_EXTERNAL` (409), sans rien appeler : un appel de salle, un appel à une boîte vocale, un numéro masqué (`Privacy`, donc pas de `cli`), un numéro qui n'en est pas un, et une urgence (classe `emergency` du plan de numérotation) : un appel d'urgence n'est jamais mis en sourdine pour une salle, qui le refuserait de toute façon (ADR 0017).
3. La salle appelle d'abord la fenêtre de la personne (jeton, comme en 8b), puis **le même numéro**, par la même autorisation à usage unique de la passerelle que pour tout appel d'une salle (`dial_out_grants`, avec la salle) et le même chemin dans OpenSIPS (`route[meet_source]` : `outbound_policy`, droits du profil, plafonds, surtaxés refusés, numéro direct présenté, durée bornée). Rien n'est ajouté à OpenSIPS pour la salle : c'est l'appel du poste vers le trunk, au nom du poste, qu'un participant ajouté par numéro suit déjà. Pendant les deux appels, la personne compte pour deux appels externes (son appel et celui de la salle) : le plafond de deux appels à la fois par personne le permet juste, et un plafond d'un seul refuse la conférence (403, `limit`), comme il aurait refusé un second appel du poste.
4. Si le numéro ne répond pas, est refusé (droits, plafond, surtaxé) ou occupé : 409 `DIAL_FAILED`, la salle est supprimée comme en 8b et l'appel avec l'opérateur reprend tel qu'il était, micro et son rétablis. La personne le lit (« … plafond d'appels vers l'extérieur atteint ou sans réponse »).
5. Si le numéro répond, le dialogue de l'opérateur n'a pas été pris : la passerelle répond `hangUp: true` et c'est la **fenêtre qui raccroche** l'ancien appel (`endForConference`), qui se termine comme une conférence. L'opérateur reçoit donc un BYE pour l'ancien appel et un appel neuf, de la même personne.

La suite est celle de 8b (liste des participants, retirer, couper le micro, quitter, « Terminer pour tous », CDR `via = conference`).

## Conséquences

Elle ne demande aucun B2BUA ni aucun changement du chemin d'appel d'OpenSIPS : un champ de plus dans le dialogue (`cli`), lu seulement par la passerelle. Elle n'ouvre aucune porte : l'appel de la salle passe par les contrôles de l'ADR 0017, comme un appel du poste. Le numéro rappelé est celui que le dialogue porte, jamais celui que dit le navigateur.

Limites, assumées :

- **L'autre partie voit un second appel, pas la continuité de son appel.** Pour un appel passé, le correspondant reçoit un appel neuf de la personne pendant qu'il est en ligne avec elle (silence, l'ancien appel est muet) ; s'il ne répond pas, la conférence n'a pas lieu. Pour un appel reçu, l'appelant est rappelé : s'il ne décroche pas, la conférence n'a pas lieu, et un numéro qui n'accepte pas d'appel entrant (un numéro d'un autre pays, un standard) est refusé comme tout appel. C'est le prix d'un proxy sans B2BUA ; un B2BUA reste l'alternative écartée de l'ADR 0019.
- **Un appel reçu d'un numéro rappelé n'est pas forcément un humain qui décroche** : une boîte vocale ou un serveur d'accueil de l'autre côté répondrait et serait mis dans la salle. La personne le voit dans la liste et peut le retirer.
- **Pas de reprise sans coupure** : entre la réponse du numéro et le BYE de l'ancien appel, l'opérateur a deux appels de la personne en même temps (un instant), et son compte en cours est doublé (plafond de deux par personne).
- **Ce qui n'est pas fait** : la conférence d'un appel de salle ou d'une boîte vocale (déjà refusée), celle d'un appel en consultation (refusée des deux côtés, ADR 0019).

## Alternatives écartées

- **Un `Replaces` ou un REFER vers l'opérateur** : aucun opérateur de trunk SIP ne les exécute ; l'opérateur n'a pas à connaître la salle.
- **Rappeler par le numéro direct de la personne seulement** : le numéro de l'autre partie est celui qui doit sonner.
- **Garder l'ancien appel et ne mixer que le nouveau** : deux appels vers le même correspondant, dont un muet pour toujours.
- **Lire le numéro dans le `From` du dialogue** : il garde un numéro caché par `Privacy`, que la salle rappellerait malgré la demande de l'appelant.
