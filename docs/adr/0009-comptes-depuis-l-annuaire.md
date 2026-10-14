# ADR 0009 : les postes viennent de l'annuaire LDAP, qui fait foi ; administrateurs par rôle du SSO

Date : 2026-10-14. État : acceptée. Décidée à l'ouverture de la PR 2c (étape 2), dans le fil de discussion du projet ; remplacé par : aucun.

## Contexte

La passerelle associe chaque utilisateur à un poste (`user_mappings`). Le POC remplissait cette table à la main (`DEV_USER_MAP`). Les organisations visées tiennent leurs comptes dans un LDAP (OpenLDAP ou Active Directory) où le poste est un attribut (`ipPhone`, ou un attribut maison), et leur SSO (LemonLDAP::NG) identifie les personnes par le même `uid`.

## Décision

La passerelle copie les comptes de l'annuaire dans ses correspondances, à intervalle régulier et à la demande d'un administrateur. L'annuaire fait foi pour les personnes qu'il connaît : leur poste, leur nom et leur service suivent l'annuaire. Les correspondances écrites à la main pour des personnes que l'annuaire ne connaît pas sont conservées, et leur poste n'est jamais repris. Un poste que l'annuaire donne à deux personnes est signalé ; celle qui l'a déjà le garde, sinon la première listée. Un conflit ne retire jamais le poste que la personne avait. Un listing vide ne retire rien. Une personne qui quitte l'annuaire ou perd son poste perd la correspondance que la synchronisation avait écrite.

Les administrateurs sont désignés par le SSO (un rôle dans une revendication du jeton), avec une liste d'utilisateurs en repli pour un SSO qui n'émet pas de rôles. Aucune requête ne peut se déclarer administratrice.

## Conséquences

- `LDAP_ATTR_EXTENSION` doit être renseigné pour synchroniser ; sans lui, l'annuaire sert à chercher, pas à attribuer.
- L'identifiant LDAP et l'identifiant du jeton doivent coïncider : c'est le cas sur une plateforme Twake (LemonLDAP::NG sur le même LDAP).
- Les groupes d'appel et les renvois viendront de la même synchronisation à l'étape 4 (provider-opensips), pas d'une saisie manuelle.
- Les écritures ne sont pas transactionnelles et le verrou d'exécution est en mémoire : un seul réplica de la passerelle synchronise pour l'instant ; l'exécution suivante répare ce qu'une panne au milieu d'une exécution aurait laissé. Un verrou en base (`pg_advisory_lock`) viendra avec l'exploitation multi-réplicas.
- SCIM n'est pas retenu : la synchronisation tirée (pull) suffit tant qu'un seul annuaire sert un déploiement ; un déploiement multi-tenant demandera une source par tenant (étape 7).

## Alternatives écartées

- Saisie manuelle des postes dans un écran d'administration : double saisie avec l'annuaire, dérive garantie.
- La correspondance manuelle prime sur l'annuaire : un poste changé dans l'annuaire ne serait jamais appliqué, et personne ne saurait pourquoi.
