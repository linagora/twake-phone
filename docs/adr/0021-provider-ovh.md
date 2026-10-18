# ADR 0021 : `provider-ovh`, l'opérateur des trunks par son API : renvoi de repli tenu chez OVH, CDR relevés et rapprochés de l'historique

Date : 2026-10-17. État : proposée. Décidée à la PR de l'étape 10b, dans le fil de discussion du projet (ligne « 10. Webhooks et adaptateur OVH » du plan : « CDR OVH rapprochés, numéro de repli piloté par l'API OVH », détaillée dans `stories/etape-10-webhooks-ovh.md`) ; remplacé par : aucun.

**Rien n'est vérifié contre le vrai OVHcloud.** Aucun accès à son API n'existe pour ce projet : le client et ses tests sont écrits d'après la documentation publique de l'API (`/1.0`, signature, `/auth/time`, droits du jeton consommateur, objets `telephony.LineOptions` et `telephony.ServiceVoiceConsumption`), et joués contre un faux serveur écrit d'après cette même documentation (`packages/provider-ovh/test/fake-ovh.mjs`). Un écart se verra au premier branchement du pilote.

## Contexte

Le trunk SIP vers OVHcloud (ADR 0016) porte les appels, mais deux choses se règlent encore à la main dans le manager d'OVH : le renvoi des appels vers un numéro extérieur quand la plateforme ne répond plus, ou quand personne ne décroche (ADR 0017 : le repli d'un numéro direct sonne d'abord à l'intérieur, 60 s pour la cible puis 60 s pour le repli). Et l'historique ne connaît que ce qu'OpenSIPS a vu : un appel reçu par OVH pendant une panne, renvoyé ou perdu, n'y est pas, et rien ne dit que l'historique est complet (FR-D4 : 99 % des appels rapprochés).

## Décision

**Un contrat d'opérateur** (`OperatorProvider`, `provider-sdk`), à côté de celui du serveur SIP. Il donne les renvois d'une ligne, chacun tel qu'il est : sa nature (un numéro, la messagerie, un fax, autre chose), son numéro, son délai. Il écrit le renvoi de repli d'une ligne. Il liste les CDR d'une ligne sur une période, tous, quelle que soit la période de facturation, et lit chacun d'eux. `packages/provider-ovh` l'implémente (`OvhOperator`, `OvhClient`) ; aucune notion d'OVH n'en sort. Un autre opérateur viendra par le même contrat.

**Le client.** Chaque requête est signée comme OVH le documente : `X-Ovh-Application`, `X-Ovh-Consumer`, `X-Ovh-Timestamp` et `X-Ovh-Signature` = `$1$` et le SHA-1 (hexadécimal) de « secret+jeton+MÉTHODE+URL complète+corps+horodatage ». L'horodatage est l'heure d'OVH : l'écart avec la nôtre est lu sur `/auth/time` (non signé), relu toutes les heures et après un refus d'horodatage (une seule nouvelle tentative). 10 s au plus par requête, aucune redirection suivie ; une réponse 2xx dont le corps n'est pas du JSON est une erreur, jamais une réponse vide. La nouvelle tentative après un refus d'horodatage ne vaut que pour ce refus-là (`QUERY_TIME_OUT`, « Query out of time »). Les refus d'OVH sont rangés en six cas (`unauthorized`, `forbidden`, `not-found`, `refused`, `rate`, `unreachable`) que l'écran traduit ; le journal garde la méthode, le chemin, le statut et le code d'OVH, jamais une clé.

**Les clés par l'environnement seulement**, pour l'organisation du pilote (`DEFAULT_TENANT`) : `OVH_APPLICATION_KEY`, `OVH_APPLICATION_SECRET`, `OVH_CONSUMER_KEY`, `OVH_BILLING_ACCOUNT` (les quatre ou aucune ; une partie seulement empêche la passerelle de démarrer en nommant ce qui manque) et `OVH_ENDPOINT` (`ovh-eu` par défaut, `ovh-ca`, `ovh-us`, rien d'autre ; seul, il empêche aussi de démarrer). Une URL libre n'est donnée au client que par les tests (`baseUrl`, en `https`, ou en `http` sur la boucle locale). Jamais en base, jamais dans le dépôt, jamais rendues par l'API. Le jeton consommateur est demandé avec les seuls droits utiles, bornés au groupe de facturation : `GET` et `PUT` de `/telephony/<groupe>/line/*/options`, `GET` de `/telephony/<groupe>/service/*/voiceConsumption` et de `…/previousVoiceConsumption`, et de leurs `/*`. Le kit pilote donne la requête, le risque qui reste avec le `PUT` (toutes les options des lignes) et la durée de validité conseillée.

**Ce qu'un trunk dit de son opérateur** (`Trunk.operator`) : ses lignes chez OVH (leurs noms de service, 16 au plus), et, si l'administrateur le demande, le renvoi de repli que la passerelle tient chez OVH (`fallback` : un numéro E.164, sur indisponibilité, sur non-réponse après plus de 120 s et 600 au plus). Sans `fallback`, la passerelle ne touche à rien chez OVH : ce qui est réglé dans le manager reste. Avec `fallback` :
- Elle le pose à l'enregistrement du trunk. La réponse attend OVH 8 s au plus ; un échec laisse le trunk enregistré, et l'écran le dit.
- Elle relit la ligne juste après l'avoir écrite. Ce qui est relu est comparé champ par champ à ce qui est demandé : nature, numéro, délai. Si OVH n'a pas gardé le réglage, ou l'a refusé, la ligne est dite `refused` et n'est plus réécrite avant le prochain enregistrement du trunk.
- Elle relit la ligne toutes les 10 minutes. Elle la remet si elle a été changée dans le manager, même pour un seul champ (un numéro, la messagerie à la place du numéro), et le dit dans le journal et à l'écran.
- Elle n'écrit que les champs de renvoi des options de la ligne (`forwardBackup*`, `forwardNoReply*`).
- Le premier renvoi tenu remplace ce qui est réglé dans le manager, comme celui d'une ligne ajoutée à un trunk qui en tient déjà un. L'écran lit et montre d'abord ce qu'ont ces lignes (`POST /admin/operator/lines`, lecture seule, relu quand la liste change), puis demande de cocher le remplacement.
- « Retirer le renvoi chez l'opérateur » (`DELETE /admin/trunks/:id/operator/fallback`) le retire des lignes, et le trunk n'en demande plus. Le bouton reste là tant qu'une ligne du trunk a été lue avec un renvoi, même trunk décoché. La suppression d'un trunk qui en tenait un fait de même, comme une ligne retirée d'un trunk qui en tient un (l'écran le dit avant l'enregistrement).

**Le retrait est tenu.** Il est d'abord écrit en base (`operator_state` `remove:<ligne>` : depuis quand, quel trunk, dernier essai, erreur, ce que la plateforme a posé, ce qu'OVH avait avant elle), puis tenté. Chaque écriture lui donne un nouvel identifiant, et il n'est effacé que tel qu'il a été lu : un relevé qui a lu les trunks avant qu'il soit écrit ne le perd jamais, même pendant une panne d'OVH vue de deux passerelles. Tant qu'il reste dû :
- chaque relevé le rejoue en premier, même pour un trunk supprimé ;
- la route répond 202 avec ce qui reste dû (`pending`), 200 seulement quand OVH l'a ; la suppression du trunk répond 202 de même, 204 sinon, et l'enregistrement d'un trunk qui ne nomme plus une ligne répond 202 avec `pending` (200 sinon) ;
- l'écran dit « pas encore retiré » et liste les retraits dus (`GET /admin/operator`, `removals`).

Un retrait ne retire que ce que la plateforme a posé :
- Il garde ce qu'elle a posé (nature, numéro, délai), ou ce qui a été lu sur la ligne quand il a été demandé. Si OVH a autre chose au moment du retrait (un administrateur l'a changé dans le manager), il n'y touche pas : le retrait est clos `changed`, l'écran le dit et une alerte `operator` (`removal-changed`) est levée. Ce qu'OVH a gardé d'une écriture de la plateforme elle-même (un délai arrondi) est relu comme le sien, jamais pris pour un changement dans le manager : le relevé suivant le retire.
- Il remet ce qu'OVH avait avant que la plateforme prenne la ligne, lu avant son premier `PUT` (`original`) : vers un numéro, la messagerie ou un fax. Ce qui n'a pas été lu, ou qui va ailleurs (`other`), n'est pas remis ; l'écran le dit avant la confirmation.
- Un renvoi d'avant vers un numéro suit les règles d'un repli et de l'appel sortant : jamais vers un numéro direct, une ligne ou le numéro d'un trunk (`OPERATOR_FALLBACK_LOOP` : l'appel reviendrait au trunk injoignable), ni vers ce que le trunk n'appelle pas (étape 6 : surtaxés jamais, outre-mer et étranger s'il les permet ; les règles par défaut pour un trunk supprimé). Sinon il n'est pas remis : l'écran le dit avant la confirmation (`originalRefused` : `loop` ou `outbound`), le journal aussi, et le retrait est clos `done` avec `unrestored`. Un renvoi d'avant qu'OVH n'a pas gardé tel quel est clos de même (`unrestored: refused`).
- Une ligne qu'OVH ne connaît plus (404) trois relevés de suite : le retrait est abandonné (`gone`), avec l'alerte `removal-gone`. Un refus des droits (`forbidden`) n'abandonne rien, puisque des droits rendus doivent pouvoir finir le retrait : il reste dû, lève l'alerte `forbidden` des clés et `removal-late` après un jour, et un administrateur peut l'abandonner. Un administrateur peut abandonner tout retrait dû (`DELETE /admin/operator/removals/:line`, 204 ; 404 sans retrait dû) : la plateforme n'y écrit plus rien. Un retrait dû depuis plus d'un jour lève `removal-late`, une fois.
- Ce que sont devenus les retraits est montré 7 jours (`closedRemovals` : `done`, `changed`, `gone`, `abandoned`).

Un relevé en cours ne remet jamais un repli retiré. Sur une passerelle, les relevés, les enregistrements et les retraits d'une organisation passent l'un après l'autre. Entre passerelles, la configuration des trunks est relue juste avant chaque `PUT`, et encore après : un repli qui n'est plus demandé à ce moment est aussitôt retiré, et le retrait est gardé dû.

Les refus :
- Le numéro de repli n'est jamais un numéro direct de l'organisation, ni une ligne ou le numéro d'un trunk ; à l'inverse, une plage de numéros directs, une ligne ou le numéro d'un trunk n'est jamais le numéro de repli d'un autre trunk : 409 `OPERATOR_FALLBACK_LOOP`.
- Une ligne n'a qu'un renvoi : deux trunks qui en demandent deux sur la même ligne sont refusés (409 `OPERATOR_LINE_SHARED`). Chaque relevé lit chaque ligne une fois, quels que soient les trunks qui la nomment. Une ligne demandée deux fois autrement (une base d'avant la règle) n'est pas écrite : l'écran dit `conflict`.
- Un renvoi n'est demandé que là où un opérateur est configuré : 409 `OPERATOR_NONE`.

**Pas de bascule pilotée à la panne.** Le renvoi sur indisponibilité d'OVH (`forwardBackup`) renvoie de lui-même quand le trunk ne répond plus, même passerelle arrêtée ; une bascule écrite par la passerelle à la panne resterait posée si elle tombait à son tour. `trunk.degraded` et `trunk.recovered` (ADR 0020) disent donc seulement ce qui est posé chez OVH, relu s'il date de plus d'une minute. Le champ `fallback` en donne `on_unavailable` et `on_no_answer` : `number`, `voicemail`, `fax`, `other`, `none`, ou `mixed` quand les lignes diffèrent. Il donne aussi `no_answer_after_sec`, jamais le numéro. L'outil abonné sait ainsi où arrivent les appelants pendant la panne.

**Les CDR d'OVH** sont relevés toutes les 10 minutes sur les dernières 48 h, par la passerelle qui tient le bail des événements (ADR 0020). Sans `SECRETS_KEY`, il n'y a ni hub ni bail : chaque passerelle fait alors ses relevés.
- Ils sont lus dans `voiceConsumption`, et aussi dans `previousVoiceConsumption` quand la fenêtre déborde sur le mois de facturation précédent (chacun une fois).
- Le relevé se fait ligne par ligne. Une ligne en erreur n'arrête pas les autres ; son erreur est donnée à part (`cdrs.lines`).
- Chaque CDR est lu une fois. Il y en a 500 au plus par relevé, partagés entre les lignes à tour de rôle.
- Chaque CDR est gardé (`operator_cdrs`, 90 jours), identifié par sa ligne et son identifiant OVH.
- Un CDR illisible est gardé `invalid`, lu une fois : une date sans décalage horaire, ou un `wayType` autre que `incoming`, `outgoing` et `transfer`. Pas d'événements en temps réel (`eventToken` d'OVH : sa forme n'est pas assez documentée pour en écrire un faux fidèle).

**Le rapprochement** se fait 5 minutes après la lecture d'un CDR, le temps que l'appel soit dans l'historique. Un CDR va à l'appel de l'historique :
- de même sens ;
- de même numéro distant, écrit en E.164 des deux côtés (OVH écrit `0033…`) ;
- qu'OVH date de 60 s avant son début à 60 s après sa fin ;
- de durée proche.

Les entrées lues sont celles de ce numéro et de cette heure seulement (`historyNear`, la colonne indexée `call_history.remote_e164`). Elles sont lues page après page, jamais tronquées : au-delà de 20 000, le CDR n'entre dans l'historique de personne.

Les règles d'appariement :
- Un CDR pour un appel et un appel pour un CDR ; le plus proche l'emporte. Un appel d'un groupe, une entrée par membre, est un appel.
- Les CDR restants sont ensuite rapprochés sans la condition de durée, ou d'un appel où la plateforme a vu `anonymous` : un appel renvoyé par OVH sur non-réponse est manqué ici et décroché là-bas, et un appelant masqué ici a son numéro chez OVH.
- Un renvoi placé par OVH (`wayType` `transfer`) est compté à part.
- Un appel entrant qu'OVH seul a eu, et qu'il a renvoyé au repli (un `transfer` de la même ligne, dont l'appelant est le numéro direct appelé, dans les 11 minutes), est écrit manqué, 0 s, et « renvoyé au numéro de repli » (`forwardedToFallback`) : le téléphone n'a pas sonné.

Un appel entrant qu'OVH a eu et la plateforme non entre dans l'historique de la personne du numéro direct appelé (sa cible, ou le poste de ses derniers chiffres ; pas un groupe), d'identifiant `ovh:<ligne>:<id>`. Quatre exceptions :
- la plateforme a, à ce moment, un appel de cette personne ;
- le numéro direct, ou le poste, a changé de mains depuis l'appel (`number_changes`, gardé 4 jours) : l'appel n'était pas au titulaire d'aujourd'hui ;
- la personne a effacé son historique depuis cet appel, ou ce numéro a été effacé avec l'historique de son titulaire d'alors. Les effacements sont datés par personne, avec leurs numéros (`history_erasures`) ; c'est vérifié aussi dans la transaction qui l'écrirait, sous le verrou de l'effacement ;
- la lecture de l'historique a dépassé sa limite. `GET /calls/history` dit d'où vient chaque entrée (`sources` : `["opensips"]`, `["opensips", "ovh"]` ou `["ovh"]`). `GET /admin/operator` donne, aux administrateurs, ce qui est posé sur chaque ligne et ce que sont devenus les CDR des 7 derniers jours, sans leurs numéros ; `POST /admin/operator/sync` relève tout de suite (2 par minute, 429 `OPERATOR_RATE`). Effacer son historique (`DELETE /me/history`), sous le verrou de l'effacement, efface aussi les numéros des CDR rapprochés de ses appels, et ceux des CDR de ses numéros directs d'avant l'effacement. Les CDR pas encore rapprochés qu'une de ses entrées prendrait (même sens, même numéro distant, à 60 s près : un appel sortant présenté avec le numéro du trunk, par exemple) perdent leurs numéros aussi. Tous ces CDR sont réglés `erased`, sans entrer dans l'historique. Un effacement ne touche que les appels de la personne : le CDR d'un autre appel à la même heure, avec un autre numéro distant, n'est pas réglé `erased`. Les heures des entrées effacées des 52 dernières heures (la fenêtre d'un relevé, 48 h, et l'appel le plus long, 4 h) sont gardées, sans numéro, avec une empreinte à clé du numéro distant (un HMAC, clé tirée de `SECRETS_KEY` ; sans elle, pas d'empreinte, et l'heure et le sens seuls comptent) (`history_erased_calls`) : un CDR relevé plus tard qu'aucune entrée ne prend, qui tombe sur l'une d'elles et en a l'empreinte, est réglé `erased` lui aussi. Une organisation sans opérateur n'en garde aucune.

**Ce qui sert au rapprochement est purgé, opérateur ou pas.** `history_erased_calls`, `number_changes` et `history_erasures` sont gardés 4 jours (`OPERATOR_KEPT_MS` : la fenêtre utile de 52 h et une marge), puis purgés toutes les heures avec les alertes, par chaque passerelle, même sans clés OVH. Un CDR commencé avant ce que ces traces gardent (4 jours moins une heure de marge : un relevé arrêté plusieurs jours) et qu'aucune entrée de l'historique ne prend n'entre dans l'historique de personne : il est réglé `erased`, ses numéros effacés, car l'effacement qui le concernait a pu être purgé. Un changement de poste ou un poste retiré par la synchronisation de l'annuaire garde l'effacement ; seul un départ de l'annuaire (le compte supprimé) l'efface (`history_erasures`, la personne et ses numéros) : un CDR relevé ensuite d'un appel à l'un de ses numéros n'est rapproché de personne et garde ses numéros.

**Ce que la plateforme sait de son opérateur est en base** (`operator_state`) :
- l'état de chaque ligne : lu, demandé, posé le, remis le, erreur, refusé ;
- le dernier relevé des CDR ;
- les relevés demandés.

Toutes les passerelles le montrent pareil, et il est gardé après un redémarrage : une remise après un changement dans le manager est encore dite comme telle.

`POST /admin/operator/sync` est compté en base (2 par minute pour l'organisation). La passerelle qui tient le bail fait le relevé : une autre le lui demande par la base, puis attend sa fin (30 s au plus). Un relevé qui échoue (aucune ligne lue) répond 502 `OPERATOR_ROUND`, un relevé pas fini à temps 504 `OPERATOR_ROUND` ; la demande est marquée répondue, avec son erreur, et n'est pas relancée.

**Alertes** (`operator`), chacune une fois, quand elle se produit (l'état est en base) :
- OVH refuse les clés (`unauthorized`) ou leurs droits (`forbidden`) au deuxième relevé de suite ;
- le taux de rapprochement des 7 derniers jours passe sous 99 % (`reconciliation`, FR-D4). Il est calculé sur les CDR que la plateforme aurait dû avoir (rapprochés et sans correspondance), dès 20. Les orphelins (la panne a déjà `trunk.degraded`), les renvois, les effacés et les illisibles n'y comptent pas. Acquittée, elle n'est relevée de nouveau qu'après être repassée au-dessus.

## Conséquences

- Le renvoi de repli ne se règle plus dans le manager d'OVH, mais dans l'écran Trunks ; un trunk sans renvoi demandé laisse le manager maître.
- L'historique dit ce que l'opérateur a vu, et l'administration le taux de rapprochement (rapprochés sur rapprochés et sans correspondance ; les orphelins, les renvois, les effacés, les illisibles et les CDR pas encore rapprochés à part).
- Une organisation, un compte de facturation OVH, par l'environnement : plusieurs organisations, chacune son compte en base (chiffré par `SECRETS_KEY`), attendent qu'on en ait besoin. Une ligne OVH partagée entre organisations n'est pas prévue.
- L'état des lignes et des relevés est en base (`operator_state`) : la même réponse quelle que soit la passerelle, et après un redémarrage. Avec `SECRETS_KEY`, une passerelle qui ne tient pas le bail ne fait pas les relevés ; elle les demande à celle qui le tient. Sans, chaque passerelle fait les siens. Dans les deux cas, ce qu'une requête d'administrateur écrit ou lit chez OVH (enregistrement d'un trunk, retrait, lecture des lignes) part de la passerelle qui la reçoit : d'où la relecture des trunks avant et après chaque `PUT`, et les retraits gardés dus.
- La migration `016` ajoute une colonne calculée à `call_history` : sur un gros historique, elle réécrit la table, et les écritures attendent (le kit pilote le dit).
- La migration `017` ajoute ce que la troisième revue a demandé (numéros des effacements, heures effacées et leurs empreintes, changements de mains, index de purge, `erased`) ; chaque instruction se rejoue sans effet, et elle répare une base passée par une version antérieure de `016`.

## Alternatives écartées

- Basculer les numéros vers le repli à la panne par la passerelle : resterait posé si elle tombait, alors que `forwardBackup` le fait déjà chez OVH.
- Rapprocher à la volée dans `GET /calls/history` : une lecture d'historique ferait des requêtes à OVH ; le relevé en base est relu sans lui.
- Les clés en base dès maintenant : l'écran d'un administrateur d'organisation donnerait accès au compte OVH de l'exploitant ; l'environnement suffit au pilote.
- Le SDK `ovh` de npm : une dépendance pour une signature d'une ligne ; le client fait 160 lignes, sans dépendance.
