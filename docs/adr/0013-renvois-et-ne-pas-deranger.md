# ADR 0013 : renvois et « ne pas déranger » dans `call_rules`, écrite par la passerelle, lue par OpenSIPS à chaque appel

Date : 2026-10-15. Révisé : 2026-11-14. État : acceptée. Remplacé par : aucun. Décidée à la PR de l'étape 4b, dans le fil de discussion du projet, qui traite aussi le constat n°15 de la revue de la PR 10 (présence choisie rangée par poste, en mémoire) et les constats de la revue de la PR 13.

## Contexte

Les renvois (immédiat, sur occupation, sur non-réponse après un délai) et un « ne pas déranger » jusqu'à une date doivent valoir onglet fermé : la règle vit dans OpenSIPS, qui reste un proxy (ADR 0010). La passerelle seule connaît les personnes et leurs postes (ADR 0009). La présence choisie était rangée par poste en mémoire : perdue au redémarrage, héritée par le nouveau titulaire d'un poste.

## Décision

- Table `call_rules`, une ligne par poste : `forward_always`, `forward_busy`, `forward_noanswer`, `noanswer_delay`, `dnd`, `dnd_until`, `dnd_message`, plus `tenant_id` et `holder` que seule la passerelle lit. Créée par `subscriber.sql` et par la passerelle ; `PUT /v1/me/forwarding` et `/v1/me/presence` l'écrivent, une ligne vide est supprimée.
- Lecture par OpenSIPS : à chaque INVITE, une requête `sqlops` asynchrone sur la clé primaire, puis une seule requête pour les postes où un renvoi peut mener (trois de profondeur). Rien en `failure_route` : le script y décide sur ces règles. Connexions à `statement_timeout` court (`RULES_QUERY_TIMEOUT_MS`) ; lecture en échec refaite une fois (`route[read_failed]`), puis l'appel continue sans règle.
- Routage avant sonnerie : renvoi immédiat ; pendant un « ne pas déranger », renvoi sur non-réponse, sinon sur occupation, sinon refus. Personne de joignable : renvoi sur non-réponse tout de suite, sinon `477`. Après sonnerie : 486, 600, 603 prennent l'occupation ; 408, 477, 480, 503 la non-réponse.
- Plusieurs fenêtres : un 486 d'une fenêtre ne décide pas (les libres sonnent) ; une seule fenêtre en communication : occupation tout de suite. L'appelant qui raccroche pendant une lecture : 487 et appel manqué.
- Anti-boucle : trois renvois au plus, jamais vers l'appelant ni un poste déjà traversé (`route[forward_to]`). La passerelle refuse une cible qui n'est pas un poste de l'organisation (400).
- Refus : `480 Do Not Disturb` avec `Twake-Dnd: 1`, `Twake-Dnd-Message`, `Retry-After`. Si le poste composé est en « ne pas déranger » et que son renvoi n'aboutit pas, l'appelant reçoit son refus, avec son message. Un collègue en « ne pas déranger » vers qui l'appel a été renvoyé refuse en `480 Temporarily Unavailable`, sans rien dire de lui.
- Transfert supervisé : l'INVITE `Replaces` ignore les règles et va au poste qui a répondu (`$dlg_val(callee)`) ; s'il nomme un autre poste, il va à ce poste.
- `acc` et `missed_calls` : `callee` est le poste atteint, `dialled` le numéro composé. `E_TWAKEPHONE_FORWARDED` et `_DND` disent à la passerelle où l'appel est parti.
- La présence choisie est rangée par personne (`user_presence`), remise au fournisseur au démarrage, oubliée à sa date. Le fournisseur n'écrit `call_rules` qu'aux entrées et sorties de « ne pas déranger ».
- Les règles suivent la personne : après chaque synchronisation d'annuaire qui change une attribution, `syncExtensions` supprime la ligne d'un poste changé de titulaire et les renvois dont la cible a changé de titulaire. Les écritures d'une organisation passent une à une, bornées dans le temps ; 409 si le titulaire a changé entre-temps.

## Compromis

- Gagné : le routage ne dépend ni de la passerelle ni du navigateur ; aucune lecture ne bloque OpenSIPS.
- Perdu / coût : base arrêtée, aucun appel ne passe (`proxy_authorize` lit `subscriber` dans la même base). Un changement fait pendant une sonnerie vaut pour l'appel suivant.
- Limite connue : une base OpenSIPS sert une seule organisation (la passerelle refuse la seconde).
- Écart : l'ADR disait `db_max_async_connections=3` ; le code a 8 par défaut (`entrypoint.sh:81`).
- Écart : le refus « ne pas déranger » peut aller à la messagerie du poste avant d'être rendu (`opensips.cfg.tpl:3790`, ADR 0022).

## Alternatives écartées

- Règles poussées dans la mémoire d'OpenSIPS (MI, `htable`) : perdues au redémarrage.
- `drouting`, `dialplan`, `avpops` : plus de configuration qu'une table à nous.
- `302 Moved` à l'appelant : chaque softphone devrait le suivre.
- Renvoi par le softphone de l'appelé : rien hors ligne.

## Code

`docker/opensips/opensips.cfg.tpl` (`route[rules_step]`, `read_failed`, `forward_to`, `dnd_reply`), `docker/opensips/entrypoint.sh`, `packages/provider-opensips/src/call-rules.ts`, `apps/gateway/src/app.ts` (`/me/forwarding`, `/me/presence`), `apps/gateway/src/store/pg.ts` (`user_presence`).
