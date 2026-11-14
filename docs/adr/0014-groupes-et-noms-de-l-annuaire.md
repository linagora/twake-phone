# ADR 0014 : groupes d'appel dans `call_groups`, lue par OpenSIPS ; le nom de chaque partie vient de l'annuaire

Date : 2026-10-15. Révisé : 2026-11-14. État : acceptée. Remplacé par : aucun.

## Contexte

Un groupe est un numéro à lui (l'accueil, le support) qui fait sonner plusieurs postes à la fois, le premier qui répond prend l'appel. Comme les renvois (ADR 0013), il doit valoir onglet fermé : la règle vit dans OpenSIPS, qui reste un proxy (ADR 0010). Le nom affiché venait du `From` du téléphone de l'appelant : n'importe quel nom.

## Décision

- Deux tables dans la base de `subscriber` (`subscriber.sql`, et la passerelle au démarrage) : `call_groups` (`members` : 12 postes au plus, dans l'ordre) et `display_names` (nom de l'annuaire par poste). La passerelle les écrit ; OpenSIPS les lit par `sqlops` asynchrone, comme `call_rules`.
- Lecture tolérante : les renvois ne dépendent jamais de ces tables. Toute lecture en échec est refaite une fois (`route[read_failed]`). Si la base dit qu'une table manque (`to_regclass`), OpenSIPS cesse de la nommer 30 s pour tous les appels (`$shv(no4c_until)`). Un numéro peut-être de groupe, règles illisibles : `480`, jamais `404`.
- Les groupes sont saisis par un administrateur dans l'app, pas lus dans l'annuaire (remplace ce point de l'ADR 0009) : `/v1/admin/groups` (409 `GROUP_EXISTS`, 403, 501 sans la capacité `groups`). Un membre est un poste de l'organisation (400 `GROUP_MEMBER_NOT_EXTENSION`) ; un poste sans titulaire reste membre et sonne dès qu'un titulaire s'enregistre.
- Un numéro de groupe n'est jamais un poste ni un compte `subscriber` (409 `GROUP_NUMBER_TAKEN`, sans dire si c'est une autre organisation). La synchronisation de l'annuaire ne donne jamais un numéro de groupe ; groupe et synchronisation s'excluent (`DirectorySync.exclusive`, 503 `SYNC_RUNNING`).
- `subscriber.holder` : à chaque `syncExtensions`, le fournisseur supprime les comptes dont le titulaire ne tient plus le poste, puis `ul_rm` retire leurs fenêtres. Garde-fous : ligne sans titulaire, liste vide ou départ massif ne suppriment rien.
- Sonnerie, seulement à la composition (jamais par renvoi : 400 `FORWARD_NOT_EXTENSION`) : une requête lit les membres dans l'ordre, sans l'appelant ni ceux en « ne pas déranger ». Une transaction porte 12 destinations (`MAX_BRANCHES` de l'image) : une fenêtre par membre à tour de rôle. Le premier qui répond prend l'appel, tm annule les autres. Renvois des membres ignorés. `disable_6xx_block` : un 603 d'un membre ne coupe pas les autres.
- Personne à faire sonner : `480` et un appel manqué du groupe. Refus (6xx) seulement si toutes les fenêtres qui ont sonné ont refusé ; sinon `480`.
- `acc` : `callee` le membre qui a répondu, `dialled` le groupe ; un membre qui a sonné sans répondre a un appel manqué.
- Isolation : tout est filtré par `tenant_id` ; une base OpenSIPS sert une seule organisation (ADR 0013).
- Noms : la passerelle écrit le nom de l'annuaire du titulaire dans `display_names`. OpenSIPS le pose dans le `From` relayé (`uac_replace_from`, nom seulement) et dans `P-Asserted-Identity` de la 2xx. `P-Asserted-Identity`, `P-Preferred-Identity`, `Remote-Party-ID` sont retirés des requêtes et réponses des téléphones. Noms nettoyés à l'écriture et à la lecture. Noms non lus : le `From` reste celui du téléphone, l'appel passe.

## Compromis

- Gagné : un groupe vaut passerelle arrêtée ; le nom affiché n'est plus choisi par l'appelant.
- Perdu / coût : au-delà de 12 membres il faudrait une image avec un autre `MAX_BRANCHES` (31 au plus) ou la sonnerie en cascade (ADR 0028). Le CANCEL de tm garde le `From` du téléphone : un poste strict pourrait répondre `481` (à vérifier, étape 11).
- Limite connue : un groupe ne déborde pas (ni renvoi, ni messagerie, ni file : ADR 0028).
- Écart : l'ADR disait `restore_mode none` ; le code règle `uac` en `restore_mode auto` pour toute la configuration (`opensips.cfg.tpl:208`),.

## Alternatives écartées

- Modules `group`, `alias_db` : sans ordre ni nom, une seule cible.
- `serialize_branches` : sonnerie en cascade, pas simultanée.
- B2BUA (`b2b_logic`) : OpenSIPS cesserait d'être un proxy, les transferts (ADR 0010) ne s'y appliqueraient plus.
- Nom affiché par l'app seule : un softphone tiers montrerait le nom de l'appelant.

## Code

`packages/provider-opensips/src/call-groups.ts`, `subscriber.ts`, `docker/opensips/opensips.cfg.tpl` (`read_failed`, groupes, `caller_name`), `docker/opensips/subscriber.sql`, `apps/gateway/src/app.ts` (`/admin/groups`), `apps/gateway/src/directory-sync.ts`.
