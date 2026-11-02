# PRD : TwakePhone

**Date :** 2026-11-02
**Méthode :** BMAD v6, phase 2 (planification), sur un projet existant
**Niveau :** 4
**Entrées :**
- [Product brief](product-brief-twake-phone-2026-11-02.md).
- Réponse LINAGORA au CCTP CANUT §7.4.6.2 : tableau de couverture de 33 lignes.
- ADR 0001 à 0034, plan en 11 étapes (README), `docs/ARCHITECTURE.md` §11 (écarts).

Chaque exigence porte sa ligne du tableau CANUT (« CANUT n ») quand elle en vient, et son état au 2026-11-02 :
- **Fait :** fusionné sur `main`, prouvé par un e2e ou un test.
- **Partiel :** une partie est faite, la limite est écrite.
- **À faire :** rien n'est fusionné.

## 1. Objectifs

1. Couvrir les 33 lignes du tableau de couverture CANUT, chacune démontrée en recette.
2. Ne rien installer sur le poste : téléphoner depuis le navigateur, dans Twake Workplace.
3. Rester souverain : open source, hébergé chez le bénéficiaire, sans licence par utilisateur.

## 2. Exigences fonctionnelles

### A. Intégration Twake (les trois fonctions gardées dans Twake par le mémoire)

#### FR-001 : Click-to-call sur tout numéro affiché
**Priorité :** Must. **CANUT 1.** **État :** Partiel.
Un clic sur un numéro dans une app Twake ouvre TwakePhone sur ce numéro. Le lien remplit le clavier sans composer ; la personne confirme.
- [x] Twake Chat ouvre `/?dial=` dans un onglet (ADR 0031).
- [x] Les apps Workplace passent par l'intent `CALL` et `PhoneLink` (ADR 0032).
- [x] Quand la personne a une ligne Wazo, `POST /calls` fait sonner son téléphone puis appelle le numéro (ADR 0033).
- [ ] Twake Mail, Contacts et Calendar affichent leurs numéros en lien d'appel.
- [ ] Un lien `tel:` sans app ouverte est pris en charge (handler du navigateur).

#### FR-002 : Appel entrant affiché dans l'ECS
**Priorité :** Must. **CANUT 2.** **État :** Partiel.
Un appel entrant est visible dans toute app Twake ouverte, et même sans onglet TwakePhone.
- [x] Notification Web Push quand aucune fenêtre n'est ouverte ; un clic ouvre l'appel (ADR 0015).
- [x] Le widget des autres apps montre l'appel et permet de répondre, refuser ou raccrocher dans la fenêtre TwakePhone (ADR 0034).
- [ ] Une carte d'appel dans Twake Chat.

#### FR-003 : Présence bidirectionnelle
**Priorité :** Must. **CANUT 3.** **État :** Partiel.
Les statuts libre, occupé, absent et « ne pas déranger » sont les mêmes dans TwakePhone, sur le serveur SIP et dans Twake.
- [x] La pastille passe à « occupé » pendant un appel et revient ensuite (étape 4).
- [x] Le statut choisi est gardé par personne et appliqué par OpenSIPS (ADR 0013).
- [ ] La présence est propagée vers Twake Chat et depuis Twake Chat.

### B. Appels

#### FR-004 : Appeler et recevoir sans téléphone physique
**Priorité :** Must. **CANUT 5.** **État :** Fait.
Le softphone WebRTC de TwakePhone (JsSIP, SIP sur WSS, DTLS-SRTP) passe et reçoit des appels internes et externes. Il fonctionne dans plusieurs fenêtres à la fois (ADR 0002, 0003).
- [x] Deux personnes s'appellent et s'entendent sur chromium, firefox et msedge (e2e SIP).
- [x] Un appel externe passe par le trunk (étape 6).

#### FR-005 : Mise en attente
**Priorité :** Must. **CANUT 13.** **État :** Fait (étape 3).

#### FR-006 : Transfert direct (aveugle)
**Priorité :** Must. **CANUT 14.** **État :** Fait (REFER, ADR 0010).

#### FR-007 : Transfert supervisé
**Priorité :** Must. **CANUT 15.** **État :** Fait (REFER avec Replaces, ADR 0010).
Limite : Wazo 26.10 perd des canaux sur un `Transfer()` PJSIP. Un transfert ne passe donc jamais par Wazo.

#### FR-008 : Conférence et ajout de participants
**Priorité :** Must. **CANUT 16.** **État :** Fait.
Un appel à deux devient une conférence LiveKit (ADR 0019), y compris avec un correspondant externe (ADR 0025). On peut passer en visio Meet (ADR 0026).

#### FR-009 : DTMF
**Priorité :** Must. **État :** Fait (étape 3, SVI de l'étape 11c-2).

#### FR-010 : Journal des appels
**Priorité :** Must. **CANUT 24.** **État :** Fait.
L'écran Récents se fonde sur les CDR du module `acc`, qui font foi (ADR 0011). Les CDR d'OVH sont rapprochés (étape 10).

#### FR-011 : Réglages audio et périphériques
**Priorité :** Should. **CANUT 12.** **État :** Partiel.
Les réglages proposent le micro, la sortie audio et le périphérique de sonnerie, gardés dans le navigateur (`Settings.tsx`).
- [ ] Le casque est choisi à chaud, pendant un appel.

#### FR-012 : Gestion de la sonnerie
**Priorité :** Could. **CANUT 29.** **État :** Partiel.
Le périphérique de sonnerie se choisit et se teste. Choisir la mélodie et le volume reste à faire.

### C. Disponibilité et renvois

#### FR-013 : « Ne pas déranger » et message planifié
**Priorité :** Must. **CANUT 4.** **État :** Fait.
Le statut porte une échéance et un message (ADR 0013). Le mémoire annonçait cette partie comme un écart à intégrer légèrement côté Twake.

#### FR-014 : Renvois immédiat, sur occupation, sur non-réponse
**Priorité :** Must. **CANUT 8 et 9.** **État :** Partiel.
Les renvois vont vers un poste de l'organisation, lus par OpenSIPS à chaque appel (ADR 0013).
- [ ] Renvoyer vers un numéro externe. La passerelle le refuse encore (`FORWARD_NOT_EXTENSION`), alors que le trunk existe depuis l'étape 6.
- [ ] Renvois selon des horaires.
- [ ] Renvoi d'un appel déjà en cours.

#### FR-015 : Messagerie vocale et message d'absence
**Priorité :** Must. **CANUT 6.** **État :** Fait.
La boîte vocale Wazo prend l'appel que rien d'autre ne prend (ADR 0022). Le message est transcrit par LinTO et annoncé dans Twake Chat par un bot Matrix (ADR 0023).

#### FR-016 : Numéro de repli en cas de panne
**Priorité :** Must. **CANUT 30.** **État :** Partiel.
`provider-ovh` tient le renvoi de repli des lignes chez OVH (ADR 0021). Le test est fait contre un faux OVH ; il n'a pas été fait contre le vrai.

### D. Groupes et parcours d'appel

#### FR-017 : Groupes d'utilisateurs et groupes de sonnerie
**Priorité :** Must. **CANUT 7 et 28.** **État :** Fait.
Groupes simultanés (ADR 0014) et séquentiels (ADR 0028). Leurs membres viennent de l'annuaire.

#### FR-018 : Files d'attente (ACD)
**Priorité :** Must. **CANUT 17.** **État :** Fait (Wazo, ADR 0028).

#### FR-019 : Standard automatique (SVI)
**Priorité :** Must. **CANUT 21.** **État :** Fait.
L'administrateur règle les menus dans l'écran « Parcours d'appel » (ADR 0028).

#### FR-020 : Routage des appels
**Priorité :** Must. **CANUT 18.** **État :** Fait.
Trunk par `dispatcher`, plan de numérotation français, numéros directs (ADR 0016). `drouting` attend un deuxième opérateur.

### E. Supervision et enregistrement

#### FR-021 : Supervision individuelle et de groupe (écoute, chuchotement, intrusion)
**Priorité :** Must. **CANUT 19.** **État :** Partiel.
La supervision passe par l'AMI de Wazo (ADR 0029). Elle ne couvre que les appels qui ont un canal chez Wazo. Un appel de personne à personne n'en a pas.

#### FR-022 : Enregistrement d'appels (local et centralisé)
**Priorité :** Must. **CANUT 20.** **État :** Partiel.
Même limite que FR-021. L'enregistrement est gardé 30 jours puis balayé.

#### FR-023 : Voyant d'occupation d'un collègue (BLF)
**Priorité :** Should. **CANUT 22.** **État :** Fait.
La présence de chaque collègue est visible dans l'annuaire et les récents.

### F. Contacts et annuaire

#### FR-024 : Contacts LDAP, CardDAV et contacts Workplace
**Priorité :** Must. **CANUT 10.** **État :** Fait.
Étape 2, plus les contacts Workplace par le pont Cozy (PR #44). Les noms affichés viennent de l'annuaire (ADR 0014).

#### FR-025 : Annuaire et recherche par nom, groupe ou numéro
**Priorité :** Must. **CANUT 25.** **État :** Fait.

#### FR-026 : Favoris
**Priorité :** Should. **CANUT 26.** **État :** Partiel.
La passerelle garde jusqu'à 100 favoris par personne (`contacts.ts`), et le client `telephony-client` les lit. Aucun écran de l'app ne les montre encore.

#### FR-027 : Numérotation rapide et touches programmables
**Priorité :** Could. **CANUT 23.** **État :** À faire.

### G. Sécurité et administration

#### FR-028 : Contrôles d'accès et autorisations
**Priorité :** Must. **CANUT 27.** **État :** Fait.
- Les rôles d'administrateur viennent du SSO (ADR 0009).
- Les droits d'appel se règlent par profil, avec des plafonds et l'anti-fraude (ADR 0017).

#### FR-029 : Appels d'urgence localisés
**Priorité :** Must. **État :** Fait.
Un appel d'urgence présente le numéro du site de l'appelant (ADR 0024).

#### FR-030 : Administration sans console
**Priorité :** Must. **État :** Fait (étape 7).
L'administrateur règle comptes, trunks, SDA, routes, limites, droits et webhooks dans l'app.

#### FR-031 : Postes depuis l'annuaire
**Priorité :** Must. **État :** Partiel.
L'annuaire LDAP fait foi (ADR 0009). La création et la suppression suivent la synchronisation de l'annuaire.
- [ ] Brancher Directory Manager ou `ldap-rest` (LINAGORA) à la place d'un SCIM écrit ici.

#### FR-032 : Alertes et notifications
**Priorité :** Must. **CANUT 11.** **État :** Fait.
- Web Push pour les appels manqués et les messages vocaux.
- Alertes administrateur : plafonds de messagerie, fraude.
- Webhooks signés `call.*` (ADR 0020).

#### FR-033 : Statistiques d'appels et d'usage
**Priorité :** Should. **CANUT 33.** **État :** À faire.
Les CDR sont là (OpenSIPS `acc`, Wazo). Il manque les tableaux de bord : volumes, durées, taux de réponse, files d'attente.

### H. Plateforme et intégrations

#### FR-034 : Accès téléphonique aux salles Meet
**Priorité :** Should. **État :** Fait.
Un numéro d'accès et le PIN de la salle ; les appels sortants d'une salle sont pris sur une autorisation (ADR 0018).

#### FR-035 : TwakePhone dans Twake Workplace
**Priorité :** Must. **État :** Partiel.
La coquille Cozy, le widget télécommande et l'intent `CALL` sont fusionnés (ADR 0032, 0034).
- [ ] L'app est publiée sur le registre Cozy.
- [ ] L'app est essayée sur un vrai LemonLDAP::NG.

#### FR-036 : Application mobile
**Priorité :** Must pour le marché (CCTP §7.4.6.1), hors MVP web. **État :** À faire.
L'app reçoit les appels en arrière-plan par APNS et FCM. Le statut est le même sur le mobile et le poste.

#### FR-037 : Serveur MCP pour les assistants
**Priorité :** Could. **État :** À faire.
`mcp-twake-phone` suivrait le modèle de `mcp-twake-mail` et `mcp-twake-chat` : appeler, lire les récents, lire les messages vocaux.

#### FR-038 : Restreindre les fonctions par profil
**Priorité :** Could. **État :** À faire.
Le mémoire annonçait un profil qui masque le chat, la visio ou l'IA pour un usage téléphonie pure.

## 3. Exigences non fonctionnelles

#### NFR-001 : Performance : établir un appel
**Priorité :** Must.
- [ ] Le temps entre le clic et la sonnerie de l'appelé est inférieur à 3 s pour 95 % des appels internes, sur le pilote.
- [ ] Une action de la passerelle (`/calls`, renvois) répond en moins de 300 ms au 95e centile, hors attente du décroché du click-to-call.

#### NFR-002 : Performance : changer la configuration sans couper les appels
**Priorité :** Must.
Aujourd'hui, un rechargement PJSIP de Wazo (environ 30 s sur un runner de CI) retarde les BYE et les INVITE des appels en cours (e2e 11a, PR #49).
- [ ] Un ajout de ligne ne retarde aucun appel en cours de plus de 2 s.

#### NFR-003 : Sécurité : authentification et secrets
**Priorité :** Must.
- [x] L'app passe par OIDC avec PKCE sur LemonLDAP::NG.
- [x] Les secrets passent par des références `env:NOM`, jamais dans le code.
- [ ] Le mode `jwt` est éprouvé en réel.
- [ ] Les secrets SIP sont par session, ou leur rotation est déclenchée.

#### NFR-004 : Sécurité : chiffrement
**Priorité :** Must. **CANUT 31.**
- [x] La signalisation passe en WSS ou TLS, le média en DTLS-SRTP.
- [ ] Le trunk opérateur est en TLS et SRTP, si l'opérateur le permet.

#### NFR-005 : Sécurité : fraude et droits
**Priorité :** Must.
- [x] Aucun numéro non permis n'atteint l'opérateur.
- [x] Les plafonds sont bornés par défaut (ADR 0017).

#### NFR-006 : Fiabilité
**Priorité :** Must.
- [ ] Le service est disponible 99,9 % du temps sur le pilote.
- [ ] Un redémarrage de la passerelle ne fait perdre aucune action sur un appel en cours. Aujourd'hui, l'appartenance des appels est gardée en mémoire.
- [ ] La passerelle tourne en plusieurs répliques (Redis).

#### NFR-007 : Accessibilité
**Priorité :** Must. **CANUT 32** (accessibilité, apparence).
- [ ] RGAA 4.1 niveau AA sur toutes les pages de l'app. Le socle date de l'étape 2 ; un audit complet est à faire.

#### NFR-008 : Compatibilité
**Priorité :** Must.
- [x] Chromium, Firefox et Edge sont joués en CI.
- [ ] Safari est vérifié.
- [x] Tout client SIP standard (Linphone, MicroSIP) s'enregistre sur OpenSIPS.

#### NFR-009 : Internationalisation
**Priorité :** Should.
- [x] L'app est en français et en anglais, et chaque clé a ses deux langues.

#### NFR-010 : Maintenabilité et preuve
**Priorité :** Must.
- [x] Chaque fonction a sa PR, une revue indépendante, un ADR et un e2e (ADR 0008).
- [ ] L'e2e SIP est vert sur 10 runs de suite. L'étape 11a est instable aujourd'hui.

#### NFR-011 : Souveraineté et licences
**Priorité :** Must.
- [x] Toute brique est open source et hébergée chez le bénéficiaire, sans licence par utilisateur.

## 4. Epics

| Epic | Nom | FR | Priorité | État | Stories restantes (estimation) |
|---|---|---|---|---|---|
| EPIC-001 | Softphone et appels de base | FR-004 à FR-010 | Must | Fait | 0 |
| EPIC-002 | Disponibilité, renvois, messagerie | FR-013 à FR-016 | Must | Presque fait | 3 (renvoi vers l'extérieur, horaires, repli contre le vrai OVH) |
| EPIC-003 | Groupes et parcours d'appel | FR-017 à FR-020 | Must | Fait | 0 |
| EPIC-004 | Supervision et enregistrement | FR-021, FR-022 | Must | Partiel | 3 (appels de personne à personne par Wazo ou rtpengine, files) |
| EPIC-005 | Intégration Twake Workplace | FR-001 à FR-003, FR-035 | Must | Partiel | 6 (Mail, Contacts, Calendar, carte Chat, présence Chat, registre) |
| EPIC-006 | Administration et sécurité | FR-028 à FR-032, NFR-003 à NFR-005 | Must | Presque fait | 3 (Directory Manager, `jwt` en réel, secrets par session) |
| EPIC-007 | Statistiques | FR-033 | Should | À faire | 4 |
| EPIC-008 | Mobile | FR-036 | Must (marché) | À faire | 8 à 10 |
| EPIC-009 | Exploitation et fiabilité | NFR-001, NFR-002, NFR-006, NFR-010 | Must | Partiel | 5 (Redis, rechargement PJSIP, pilote réel, stabilité e2e) |
| EPIC-010 | Confort et assistants | FR-011, FR-012, FR-026, FR-027, FR-037, FR-038 | Could | À faire | 5 |

## 5. Stories prioritaires (prochain sprint)

1. En tant que testeur, je veux que l'e2e SIP soit vert de façon stable, pour que la CI prouve chaque PR (EPIC-009, PR #49).
2. En tant qu'agent, je veux appeler un numéro affiché dans Twake Mail en un clic (EPIC-005).
3. En tant qu'agent, je veux voir l'appel entrant dans Twake Chat et y répondre (EPIC-005).
4. En tant qu'administrateur, je veux ajouter une ligne sans perturber les appels en cours (EPIC-009, NFR-002).
5. En tant qu'exploitant, je veux le pilote sur un vrai LemonLDAP::NG et un vrai trunk OVH (EPIC-009).
6. En tant que responsable de site, je veux les volumes et les taux de réponse par file (EPIC-007).

## 6. Écarts avec la réponse au CCTP (à annoncer au bénéficiaire)

| Mémoire | TwakePhone | Pourquoi | ADR |
|---|---|---|---|
| Linphone sur le poste, aucune pile SIP dans Twake | Softphone WebRTC dans l'app TwakePhone. Linphone reste possible. | Rien à installer, même pile que le futur mobile | 0002 |
| Flexisip (proxy, présence, push) | OpenSIPS 3.6 et rtpengine | Un serveur SIP de moins ; anti-fraude et trunk dans le même serveur | 0004 |
| XiVO (IPBX) | Wazo Platform 26.10 (même lignée, GPLv3) derrière OpenSIPS | Gouvernance de XiVO ; API REST de Wazo | 0005 |
| Le click-to-call ouvre une URI `tel:` vers Linphone | Lien vers TwakePhone (`/?dial=`), intent `CALL`, ou Wazo fait sonner la ligne | Pas de client lourd | 0031 à 0033 |
| Notification CTI par Flexisip | Événements d'OpenSIPS vers la passerelle, Web Push, widget | Même résultat sans Flexisip | 0011, 0015, 0034 |
| Provisioning XML ou QR code | Session Twake, pas de provisioning | Plus rien à provisionner sur le poste | 0002 |

## 7. Questions ouvertes pour le PO

1. Le bénéficiaire a-t-il validé l'écart Linphone, Flexisip, XiVO ? Sinon, quel ADR le remplace ?
2. Le mobile (§7.4.6.1) fait-il partie de l'échéance du 2026-12-08 ?
3. Quelles statistiques la recette attend-elle (liste des indicateurs) ?
4. La supervision et l'enregistrement doivent-ils couvrir les appels de personne à personne ?
5. Le provisioning passe-t-il par Directory Manager (`ldap-rest`) ?
