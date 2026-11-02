# Product Brief : TwakePhone

**Date :** 2026-11-02
**Méthode :** BMAD v6, phase 1 (analyse), menée sur un projet existant (brownfield)
**Niveau de projet :** 4 (plus de 40 stories, plusieurs équipes et briques)
**Sources :** réponse LINAGORA au CCTP CANUT §7.4.6.2 « Intégration avec la softphonie » (Notion TWP-633 « Integrated Softphone »), README et plan en 11 étapes, ADR 0001 à 0034, `docs/ARCHITECTURE.md`, [écosystème LINAGORA](ecosysteme-linagora.md)

## 1. Résumé

TwakePhone est la téléphonie de Twake Workplace : passer et recevoir des appels depuis le poste de travail, sans téléphone physique, dans l'interface de l'espace collaboratif (ECS). La solution est 100 % open source et souveraine, sans licence commerciale. Elle couvre les 33 fonctions de la réponse au CCTP CANUT et le click-to-call depuis toutes les apps Twake.

## 2. Problème

- **Problème :** les agents des bénéficiaires du marché CANUT doivent téléphoner depuis l'ECS comme avec Teams Phone ou Zoom Phone. Aujourd'hui, Twake n'a pas de téléphonie.
- **Pourquoi maintenant :** le marché CANUT exige la softphonie (§7.4.6.2) et la mobilité (§7.4.6.1). Le projet Notion TWP-633 est « In Dev », échéance le 2026-12-08.
- **Si rien n'est fait :** le lot softphonie du marché n'est pas livré. Les bénéficiaires gardent un PABX propriétaire à côté de Twake.

## 3. Utilisateurs

- **Principaux :** les agents d'un bénéficiaire. Ils appellent, reçoivent, transfèrent, laissent des messages et voient la présence de leurs collègues.
- **Secondaires :**
  - Les administrateurs téléphonie du bénéficiaire : postes, trunks, numéros directs (SDA), droits, parcours d'appel, supervision.
  - Les standardistes et agents de file d'attente.
  - Les exploitants LINAGORA, qui déploient et opèrent la pile.
- **Besoins :** un appel en un clic depuis tout numéro affiché, l'appel entrant visible où que l'on soit dans Twake, une présence juste partout, et rien à installer.

## 4. Solution

- **Solution :** une app web TwakePhone avec un softphone WebRTC (JsSIP), une passerelle (Fastify, PostgreSQL) neutre vis-à-vis du serveur SIP, OpenSIPS 3.6 et rtpengine comme serveur SIP, Wazo Platform 26.10 derrière OpenSIPS pour les fonctions de central, LiveKit SIP pour Meet, et LinTO pour la transcription.
- **Fonctions clés :**
  - Clavier, récents, annuaire, présence.
  - Appel en cours : attente, DTMF, transfert direct ou supervisé, conférence, passage en visio.
  - Renvois, « ne pas déranger » planifié, groupes simultanés et séquentiels, files d'attente, SVI.
  - Messagerie vocale transcrite et annoncée dans Twake Chat.
  - Trunk opérateur (OVH), droits, plafonds, anti-fraude, appels d'urgence par site.
  - Webhooks signés, administration sans console.
  - Click-to-call et télécommande depuis les autres apps Workplace.
- **Valeur :** une seule interface Twake, pas de client lourd, pas de licence par utilisateur, une pile hébergée chez le bénéficiaire.

## 5. Objectifs

- **Objectifs :** gagner et livrer le lot softphonie du CCTP CANUT. Faire de la téléphonie une brique de Twake Workplace, réutilisable sur d'autres marchés publics.
- **Mesures de succès :**
  - Les 33 lignes du tableau de couverture du CCTP sont « Complet » et démontrées en recette.
  - Un appel s'établit en moins de 3 s après le clic, entre deux postes de la plateforme.
  - Aucun appel externe hors des droits de l'appelant.
  - Le pilote tourne sur un domaine réel avec un trunk réel.
- **Valeur métier :** l'unité d'œuvre du BPU « fourniture d'une solution de softphonie complète » est livrable sans licence tierce.

## 6. Périmètre

**Dans le périmètre :**
- MVP web (étapes 1 à 10 du plan), terminé.
- Fonctions de central sur Wazo (étape 11 : messagerie, SVI, files, enregistrement, supervision, click-to-call), fusionnées ; l'e2e est à stabiliser.
- Intégration Workplace : coquille Cozy, widget, intent `CALL`, liens dans Chat (étape 9), en cours.

**Hors périmètre :**
- Minutes de communication (à la charge du bénéficiaire, via son opérateur).
- Intégration des PABX propriétaires (Alcatel, Avaya), en prestation complémentaire.
- Linphone desktop et Flexisip (retirés, ADR 0002 et 0004).

**Plus tard :**
- App mobile (§7.4.6.1 : `sip_ua` en Dart, push APNS et FCM).
- Carte d'appel et présence dans Twake Chat, click-to-call dans Mail.
- Provisioning automatique (création et suppression des postes) par Directory Manager ou SCIM.
- Statistiques et tableaux de bord.
- Serveur MCP `mcp-twake-phone`.
- Plusieurs répliques de la passerelle (Redis).

## 7. Parties prenantes

- **PO du projet TWP-633** (équipe Twake Workplace) : priorités, recette.
- **Responsable produit TwakePhone** (LINAGORA) : plan, ADR, revues.
- **Bénéficiaires CANUT** : exigences, recette, écarts acceptés.
- **Équipes Twake Chat, Mail et Workplace** : points d'intégration dans leurs apps.
- **Exploitation LINAGORA** : déploiement, supervision, trunks.

## 8. Contraintes et hypothèses

**Contraintes :**
- Open source uniquement, sans licence commerciale (GPL, AGPL, MPL acceptées).
- Hébergement dans l'infrastructure du bénéficiaire.
- SSO LemonLDAP::NG, annuaire LDAP qui fait foi.
- Accessibilité RGAA.
- Un ADR par décision, une PR par fonction, une revue indépendante, et l'e2e comme preuve (ADR 0008).

**Hypothèses :**
- Le bénéficiaire accepte le softphone navigateur à la place de Linphone. C'est à confirmer, voir le PRD.
- Le bénéficiaire accepte Wazo Platform à la place de XiVO (même lignée Asterisk). C'est à confirmer aussi.
- Un navigateur lancé suffit pour recevoir sans onglet ouvert (Web Push).

## 9. Critères de succès

- La recette CANUT passe sur les 33 fonctions, avec démonstration de chaque fonction.
- L'e2e SIP est vert de façon stable sur trois navigateurs (chromium, firefox, msedge).
- Le pilote tourne sur un vrai LemonLDAP::NG et un vrai trunk OVH.
- L'app est publiée sur le registre Cozy et ouverte depuis la grille d'apps.

## 10. Calendrier

- **Cible :** 2026-12-08 (échéance TWP-633).
- **Jalons :**
  - Étapes 1 à 8 et 10 : fusionnées entre le 14 et le 17 octobre 2026 (l'étape 10 contre un faux OVH).
  - Étape 9 (Workplace) : PR #42 à #46 fusionnées le 2026-11-01. Il reste Mail, la carte d'appel et la présence dans Chat.
  - Étape 11 : 11a et 11b fusionnées les 18 et 19 octobre, puis 11c, 11d et le click-to-call. Il reste à stabiliser l'e2e (PR #49).
  - Pilote réel : à planifier.
  - Recette CANUT : à planifier.

## 11. Risques

| Risque | Probabilité | Impact | Réponse |
|---|---|---|---|
| Le bénéficiaire refuse l'écart Linphone, Flexisip, XiVO | Moyenne | Élevé | L'annoncer tôt. Linphone reste utilisable sur OpenSIPS (ADR 0002). |
| Recharger PJSIP à chaque nouvelle ligne bloque les appels ~30 s | Élevée | Moyen | Contourné dans l'e2e (#49). En production : regrouper les écritures et recharger hors pointe. |
| Le mobile (§7.4.6.1) n'est pas commencé | Élevée | Élevé | Lui donner une étape 12 et une estimation. |
| Les intégrations non jouées en réel (LemonLDAP::NG, OVH, push) | Moyenne | Moyen | Pilote sur un domaine réel (ADR 0012). |
| Une seule réplique de la passerelle, l'état des appels en mémoire | Moyenne | Moyen | Redis avant la mise en production multi-bénéficiaires. |
