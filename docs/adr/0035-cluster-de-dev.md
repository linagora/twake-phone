# ADR 0035 : TwakePhone sur le cluster de dev, un pod en réseau de l'hôte comme le kit pilote

Date : 2026-11-02. État : proposée. Demandée pour tester le MVP web sur le cluster de dev de Twake Workplace, avec son SSO et son annuaire ; remplacé par : aucun.

## Contexte

Le cluster de dev (Kubernetes, décrit par le dépôt `twake-workplace-cozy-apps` en helmfile) héberge Chat, Mail, Meet et le SSO LemonLDAP::NG. TwakePhone n'y a ni image ni chart. Le kit pilote (ADR 0012) tient parce que tout partage la boucle de la machine : la passerelle parle à OpenSIPS par le MI (`mi_datagram`, sans authentification), OpenSIPS à rtpengine par son socket de contrôle, et rtpengine écrit dans le SDP une adresse que les navigateurs joignent en UDP. Séparer ces services en pods ordinaires mettrait le MI sur le réseau du cluster, et le son derrière un NAT de Kubernetes.

## Décision

- **Images** : le job `pilot` de la CI publie sur Harbor (`harbor.linagora.com/twake-workplace/twake-phone-{web,gateway,opensips,rtpengine}`) les images qu'il vient de jouer en e2e, taguées par le commit, sur main (avec `latest`) et à la demande, jamais sur une PR. L'image d'OpenSIPS embarque `subscriber.sql`, rejouable, que le déploiement applique avant le démarrage.
- **Un pod en réseau de l'hôte**, épinglé à un nœud : rtpengine, OpenSIPS, la passerelle et l'app, comme le kit pilote. Le MI et le contrôle de rtpengine restent sur la boucle du nœud. L'app, la passerelle et le WebSocket d'OpenSIPS écoutent sur l'adresse privée du nœud, pour Traefik ; jamais sur `0.0.0.0` (les nœuds ont une adresse publique). rtpengine annonce `<privée>!<publique>` du nœud ; sa plage UDP est ouverte sur ce nœud seulement.
- **Entrée** : un Ingress Traefik sur un seul nom, avec le même partage que Caddy : `/api` vers la passerelle, `/sip` vers le WebSocket d'OpenSIPS, le reste vers l'app.
- **Ce que le cluster fournit** : le PostgreSQL partagé (base créée par `db-bootstrap`), le SSO LemonLDAP::NG (client OIDC public avec PKCE, jeton d'accès JWT pour la passerelle, `AUTH_MODE=jwt`), l'OpenLDAP de dev (compte de lecture), les secrets par OpenBao.
- **Le chart** vit dans `twake-workplace-cozy-apps` (`charts/twake-phone`), comme les autres charts locaux du dépôt, dans le namespace `twakephone-mvp`.
- **Hors périmètre** : Wazo (étape 11) et LiveKit SIP. Wazo garde son propre compose, sur une machine à part s'il faut le brancher.

## Conséquences

Une seule réplique, sur un nœud fixe : la perte du nœud coupe la téléphonie, comme pour le kit pilote. Les ports du pod sont ceux du nœud : ils ne doivent croiser aucun autre pod en réseau de l'hôte (le chart les rend réglables). Le mode `jwt` de la passerelle est joué ici pour la première fois contre un vrai SSO. Un appel par le navigateur reste la seule preuve du déploiement (`yarn e2e:pilot` contre l'adresse du cluster).

## Alternatives écartées

- **Des pods ordinaires, rtpengine seul en réseau de l'hôte** : le MI d'OpenSIPS passerait sur le réseau du cluster, sans authentification.
- **rtpengine derrière un Service LoadBalancer UDP** : mille ports à déclarer, et une adresse vue par rtpengine qui n'est pas celle des navigateurs.
- **Une VM avec le kit pilote** : plus rapide, mais hors du SSO, de l'annuaire et du dépôt qui décrit la dev.
