# ADR 0009 : les postes viennent de l'annuaire LDAP, qui fait foi

Date : 2026-10-14. Révisé : 2026-11-14. État : acceptée. Remplacé par : aucun. Décidée à l'ouverture de la PR 2c (étape 2), dans le fil de discussion du projet.

## Contexte

La passerelle associe chaque utilisateur à un poste (`user_mappings`). Le POC remplissait cette table à la main (`DEV_USER_MAP`). Les organisations visées tiennent leurs comptes dans un LDAP (OpenLDAP ou Active Directory) où le poste est un attribut (`ipPhone`, ou un attribut maison), et leur SSO (LemonLDAP::NG) identifie les personnes par le même `uid`.

## Décision

- La passerelle copie les comptes de l'annuaire dans `user_mappings`, à intervalle régulier et à la demande d'un administrateur.
- L'annuaire fait foi pour les personnes qu'il connaît : poste, nom et service le suivent. Les correspondances écrites à la main pour des personnes inconnues de l'annuaire sont conservées, et leur poste n'est jamais repris.
- Un poste que l'annuaire donne à deux personnes est signalé ; celle qui l'a déjà le garde, sinon la première listée. Un conflit ne retire jamais le poste que la personne avait.
- Un listing vide ne retire rien. Une personne qui quitte l'annuaire ou perd son poste perd la correspondance que la synchronisation avait écrite.
- Les administrateurs sont désignés par le SSO (un rôle dans une revendication du jeton), avec une liste d'utilisateurs en repli pour un SSO sans rôles. Aucune requête ne peut se déclarer administratrice.
- `LDAP_ATTR_EXTENSION` doit être renseigné pour synchroniser ; sans lui, l'annuaire sert à chercher, pas à attribuer.
- Les groupes d'appel et les renvois viennent de la même synchronisation (étape 4), pas d'une saisie manuelle.

## Compromis

- Gagné : une seule saisie, celle de l'annuaire ; pas de dérive silencieuse.
- Perdu / coût : l'identifiant LDAP et celui du jeton doivent coïncider (c'est le cas sur une plateforme Twake, LemonLDAP::NG sur le même LDAP).
- Limite connue : les écritures ne sont pas transactionnelles et le verrou d'exécution est en mémoire : un seul réplica synchronise ; l'exécution suivante répare une panne en cours (`pg_advisory_lock` viendra avec le multi-réplicas). SCIM n'est pas retenu : la synchronisation tirée suffit pour un annuaire par déploiement ; un déploiement multi-tenant demandera une source par tenant (étape 7).

## Alternatives écartées

- Saisie manuelle des postes dans un écran d'administration : double saisie avec l'annuaire, dérive garantie.
- La correspondance manuelle prime sur l'annuaire : un poste changé dans l'annuaire ne serait jamais appliqué, et personne ne saurait pourquoi.

## Code

`apps/gateway/src/directory-sync.ts` (`DirectorySync`), `apps/gateway/src/ldap-directory.ts`, `apps/gateway/src/main.ts` (`LDAP_ATTR_EXTENSION`), table `user_mappings`.
