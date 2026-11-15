# ADR 0035 : TwakePhone sur le cluster de dev : images sur Harbor, chemin du son à décider

Date : 2026-11-02. Révisé : 2026-11-14. État : proposée. Remplacé par : aucun.

## Contexte

Le cluster de dev (Kubernetes, helmfile dans `twake-workplace-cozy-apps`) héberge Chat, Mail, Meet et le SSO LemonLDAP::NG. Le kit pilote (0012) tient parce que tout partage la boucle de la machine : MI d'OpenSIPS sans authentification, contrôle de rtpengine, et son annoncé aux navigateurs en UDP. Séparer ces services en pods ordinaires mettrait le MI sur le réseau du cluster.

## Décision

- Images : le job `pilot` de `.github/workflows/ci.yml` publie sur `harbor.linagora.com/twake-workplace/twake-phone-{web,gateway,opensips,rtpengine}` les images qu'il vient de jouer, taguées par le commit, `latest` sur main, jamais sur une PR. L'image d'OpenSIPS embarque `subscriber.sql`, rejouable.
- Un pod en réseau de l'hôte, épinglé à un nœud (rtpengine, OpenSIPS, passerelle, app) : MI et contrôle de rtpengine sur la boucle ; écoute sur l'adresse privée du nœud, jamais `0.0.0.0`.
- Entrée : un Ingress Traefik, un seul nom : `/api` vers la passerelle, `/sip` vers le WebSocket d'OpenSIPS, le reste vers l'app.
- Fournis par le cluster : PostgreSQL partagé, SSO (client OIDC public avec PKCE, jeton JWT, `AUTH_MODE=jwt`), OpenLDAP de dev, secrets OpenBao. Chart prévu dans `twake-workplace-cozy-apps` (`charts/twake-phone`), namespace `twakephone-mvp`. Sans Wazo ni LiveKit SIP.
- Écart : l'ADR disait que rtpengine annonce `<privée>!<publique>` du nœud avec sa plage UDP ouverte. Romain (infra) a dit le 2026-11-03 : pas de NodePort sur le cluster, les nœuds ne sont pas joignables depuis Internet (ils passent par une gateway), et l'UDP ouvert sur un nœud est refusé. Ce pod en réseau de l'hôte ne passe donc pas. Le chemin du son est à décider avec l'équipe du cluster ; rien n'est tranché ici. Le chart n'est pas dans ce dépôt (non poussé) et ne doit pas être proposé tel quel.

## Compromis

- Gagné : des images identiques à celles de l'e2e, publiées sans étape manuelle.
- Coût : une réplique, un nœud fixe (sa perte coupe la téléphonie) ; ses ports ne doivent croiser aucun autre pod en réseau de l'hôte.
- Limite connue : le son n'est pas joignable depuis les navigateurs tel que décrit ; le mode `jwt` n'est pas joué contre le vrai SSO ; seul un appel par navigateur prouve le déploiement (`yarn e2e:pilot`).

## Alternatives écartées

- Pods ordinaires, rtpengine seul en réseau de l'hôte : le MI passerait sur le réseau du cluster.
- rtpengine derrière un Service LoadBalancer UDP : une plage de ports à déclarer, et une adresse vue par rtpengine qui n'est pas celle des navigateurs.
- Une VM avec le kit pilote : hors du SSO, de l'annuaire et du dépôt de la dev.
- À explorer avec l'équipe du cluster : passage du son par leur gateway (non évalué).

## Code

`.github/workflows/ci.yml` (publication Harbor), `docker/Dockerfile.web`, `docker/Dockerfile.gateway`, `docker/opensips/Dockerfile`, `docker/rtpengine/`, `docker/pilot/`.
