# ADR 0033 : click-to-call, Wazo fait sonner le téléphone de la personne puis le lui fait appeler

Date : 2026-10-30. État : proposée (en revue, PR #45). Décidée dans le fil de discussion du projet (« faire ce qu'il manque pour arriver au niveau du POC ») ; s'appuie sur l'ADR 0027 (les lignes de Wazo, l'appel que Wazo place) et l'ADR 0029 (le compte AMI réservé à `Originate`) ; remplacé par : aucun.

## Contexte

Le POC savait lancer un appel depuis le serveur (`POST /calls`, Asterisk par ARI) : le téléphone de la personne sonnait, elle décrochait, l'appel partait. C'est ce qu'il faut à qui garde un téléphone de bureau ou Linphone (la réponse au CCTP CANUT §7.4.6.2 et l'ADR 0002 les laissent utilisables). Depuis le retrait d'Asterisk (PR 4c), `provider-opensips` répond 501 : OpenSIPS est un proxy, il ne place pas d'appel. Wazo, depuis l'étape 11c-1, place des appels vers les lignes des personnes (AMI `Originate`, ADR 0027), mais OpenSIPS refuse tout transfert (REFER) dans un tel appel, comme avec l'opérateur : un transfert y ferait composer n'importe quoi, hors de `route[outbound_policy]`.

## Scénario de démo (écrit avant le code)

1. Bob a une ligne chez Wazo (son téléphone de bureau, Linphone, ou ses fenêtres). Dans le clavier, il tape 102 et choisit « Appeler depuis mon téléphone » (ou « Appeler » quand le navigateur n'a pas de softphone).
2. Son téléphone sonne : « Twake Phone (102) ». Il décroche.
3. Son téléphone appelle 102, avec son compte : Jean sonne et voit « Bob Durand ». Ils se parlent ; la passerelle n'a lancé aucun appel vers 102.

## Décisions

### 1. Wazo sonne la ligne, puis transfère ; le téléphone compose lui-même

`POST /calls`, quand le serveur SIP ne place pas d'appel (`calling.outbound` faux) et que la personne a une ligne chez Wazo (`listWazoLines`), demande au compte AMI `originate` de la passerelle (ADR 0029) un `Originate` : canal `PJSIP/<extension>`, appelant `"Twake Phone" <cible>`, application `Transfer(PJSIP/sip:<cible>@<domaine SIP>)`. Le téléphone qui décroche reçoit un REFER vers la cible et l'appelle comme tout appel : ses droits, ses plafonds, l'anti-fraude et le trunk s'appliquent sans exception, puisque c'est son appel. La passerelle répond 202 dès qu'Asterisk a pris l'appel à placer (la personne a 30 s pour décrocher) ; elle n'a pas de canal à piloter ensuite.

### 2. Une seule exception au refus du REFER dans un appel de Wazo, sur une autorisation de la passerelle

Avant de faire sonner la ligne, la passerelle écrit une autorisation dans `dial_out_grants` (la table des appels des salles de Meet, ADR 0018) : `room = 'click-to-call'`, cette extension, ce numéro, une minute, un jeton tiré et jamais transmis (aucune salle ne peut donc la présenter). OpenSIPS garde, à l'INVITE de Wazo sur le socket de lignes, la ligne appelée (`wline_callee`) et le numéro montré comme appelant (`wline_caller`). Dans ce dialogue, un REFER passe seulement s'il vient du côté de Wazo (le socket de lignes), s'il n'a qu'un `Refer-To`, si ce `Refer-To` est exactement `sip:<ce numéro>@<SIP_DOMAIN>` (avec ou sans chevrons, sans `Replaces` ni autre hôte), et si OpenSIPS prend, une fois, l'autorisation de cette ligne pour ce numéro (`UPDATE … RETURNING`, `used_by = 'click-to-call'`). Un appel que Wazo place pour une autre raison (une file, un standard, un appel de l'extérieur dont le numéro peut être n'importe quoi) n'en a pas : tout autre REFER y reste refusé (`Twake-Call-Refused: transfer-external`).

### 3. Le choix dans le clavier

`/capabilities` dit `clickToCall` (et `calling.outbound`) pour qui a une ligne. Sans softphone dans le navigateur (`off`), « Appeler » passe par là ; sinon (connecté, en connexion, en échec), un second bouton « Appeler depuis mon téléphone » le propose, une demande à la fois. Jamais depuis un lien seul (ADR 0031).

## Conséquences

- L'`Originate` fait sonner tous les contacts de la ligne, fenêtres comprises : une fenêtre qui décroche suit le REFER (le softphone suit déjà un transfert vers son domaine) et compose depuis le navigateur.
- Le CDR montre deux appels : celui de Wazo vers la ligne (`via wazo`, l'appelant est la cible) et celui du téléphone vers la cible.
- Prouvé : `config.spec.ts` (l'exception et ses conditions), la requête de l'autorisation lue dans le gabarit et jouée contre PostgreSQL (`dial-out-grants.spec.ts` : une fois, sa ligne, son numéro, avant son heure, jamais une autorisation de salle), `provider-wazo` (l'`Originate` exact, refus de toute valeur qui dirait plus qu'un numéro), la passerelle (offert à qui a une ligne seulement, autorisation écrite avant la sonnerie, 400, 409, 503), le gabarit lu par le vrai OpenSIPS de la pile. L'e2e SIP (Bob décroche sur sa seconde fenêtre, sa fenêtre appelle Jean, son et CDR) tourne en CI.

## Ce qui reste

- Un téléphone qui ne suit pas les REFER (rare ; Linphone et les postes SIP courants le font) décroche sur un appel qui ne mène nulle part : Asterisk raccroche après l'échec du transfert.
- Pas de suivi de l'appel par la passerelle (pas de canal) : le 202 dit seulement qu'Asterisk a pris l'appel à placer ; une ligne morte, 30 s sans réponse ou un transfert refusé ne se voient pas dans l'app (« votre téléphone sonne »), seulement sur le téléphone et dans les Récents.
- `wazo_lines` peut avoir un peu de retard sur Wazo : une ligne retirée à l'instant reste proposée, et rien ne sonne.
- Le domaine que la passerelle donne (`domain` du provider OpenSIPS) doit être le `SIP_DOMAIN` d'OpenSIPS : sinon chaque transfert est refusé (même valeur dans la stack et le kit pilote).
- La clé d'idempotence de `POST /calls` n'est pas lue pour un click-to-call : le clavier n'envoie qu'une demande à la fois.
- Non vérifié contre un vrai Linphone ni un poste de bureau ; l'e2e joue des fenêtres du navigateur.

## Alternatives écartées

Que Wazo appelle la cible lui-même et ponte les deux appels : son socket de lignes deviendrait une sortie vers l'opérateur, hors des droits et plafonds de la personne (ADR 0016, 0017). Un B2BUA dans OpenSIPS (`b2b_logic`) : un module de plus pour ce que Wazo fait déjà. Marquer l'appel par un en-tête posé par Asterisk : un `Originate` ne pose pas d'en-tête PJSIP sans dialplan à nous. Se fier au seul numéro montré : il vient de l'appelant pour un appel de l'extérieur que Wazo transmet, donc n'importe quoi (première revue de la PR #45) ; l'autorisation de la passerelle le borne à ce que la personne a demandé.
